/**
 * Inventory Sync API â€” Phases 6 & 7
 * Phase 6: Pre-sync comparison (WMS vs Medusa)
 * Phase 7: Push WMS quantities to Medusa
 */

import express, { Request, Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';

const router = express.Router();

const MEDUSA_URL = process.env.MEDUSA_API_BASE_URL || 'https://bisley-shop.medusajs.app';
const MEDUSA_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || 'matt@ovara.co.uk';
const MEDUSA_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || 'Drautsrab85!';

let _medusaToken: string | null = null;
let _medusaTokenExpiry = 0;

async function getMedusaToken(): Promise<string> {
  if (_medusaToken && Date.now() < _medusaTokenExpiry) return _medusaToken;
  const res = await fetch(`${MEDUSA_URL}/auth/user/emailpass`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: MEDUSA_EMAIL, password: MEDUSA_PASSWORD }),
  });
  const data = await res.json() as any;
  if (!data.token) throw new Error('Medusa auth failed');
  _medusaToken = data.token;
  _medusaTokenExpiry = Date.now() + 50 * 60 * 1000;
  return data.token;
}

async function fetchMedusaInventory(): Promise<Map<string, number>> {
  const token = await getMedusaToken();
  const qtyMap = new Map<string, number>();
  let offset = 0;
  while (true) {
    const res = await fetch(
      `${MEDUSA_URL}/admin/inventory-items?limit=100&offset=${offset}&fields=id,sku,location_levels.available_quantity`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json() as any;
    for (const item of data.inventory_items ?? []) {
      const qty = (item.location_levels ?? []).reduce((s: number, l: any) => s + (l.available_quantity ?? 0), 0);
      if (item.sku) qtyMap.set(item.sku, qty);
    }
    offset += 100;
    if (offset >= (data.count ?? 0)) break;
  }
  return qtyMap;
}

async function getMedusaItemInfo(sku: string): Promise<{ itemId: string; locationId: string } | null> {
  const token = await getMedusaToken();
  const res = await fetch(
    `${MEDUSA_URL}/admin/inventory-items?sku=${encodeURIComponent(sku)}&fields=id,sku,location_levels.id,location_levels.location_id`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json() as any;
  const item = data.inventory_items?.[0];
  const level = item?.location_levels?.[0];
  return level ? { itemId: item.id, locationId: level.location_id } : null;
}

// Pre-sync comparison
router.get('/pre-sync', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const wmsResult = await query(`
      SELECT product_sku as sku, colour_code as colour, SUM(quantity) as wms_qty
      FROM warehouse_inventory GROUP BY product_sku, colour_code ORDER BY product_sku
    `);

    if (wmsResult.rows.length === 0) {
      return res.json({ items: [], total: 0, diffs: 0, message: 'No WMS inventory yet. Stock items via Bay Assignment first.' });
    }

    let medusaMap: Map<string, number>;
    try {
      medusaMap = await fetchMedusaInventory();
    } catch (err) {
      return res.status(503).json({ error: 'Could not reach Medusa API', detail: (err as Error).message });
    }

    const items = wmsResult.rows.map(row => {
      const medusaQty = medusaMap.get(row.sku) ?? 0;
      const wmsQty = parseInt(row.wms_qty);
      return { sku: row.sku, colour: row.colour, wms_qty: wmsQty, medusa_qty: medusaQty, diff: wmsQty - medusaQty, in_medusa: medusaMap.has(row.sku) };
    });

    res.json({ items, total: items.length, diffs: items.filter(i => i.diff !== 0).length, in_sync: items.filter(i => i.diff === 0).length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Pre-sync comparison failed' });
  }
});

// Sync WMS â†’ Medusa
router.post('/sync', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { skus } = req.body;
    const token = await getMedusaToken();

    let sql = `SELECT product_sku as sku, SUM(quantity) as qty FROM warehouse_inventory`;
    const params: any[] = [];
    if (skus?.length) { sql += ` WHERE product_sku = ANY($1::text[])`; params.push(skus); }
    sql += ` GROUP BY product_sku`;

    const wmsItems = await query(sql, params);
    const results: any[] = [];

    for (const item of wmsItems.rows) {
      const wmsQty = parseInt(item.qty);
      const info = await getMedusaItemInfo(item.sku);

      if (!info) { results.push({ sku: item.sku, status: 'NOT_IN_MEDUSA', wms_qty: wmsQty }); continue; }

      const updateRes = await fetch(
        `${MEDUSA_URL}/admin/inventory-items/${info.itemId}/location-levels/${info.locationId}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ stocked_quantity: wmsQty }),
        }
      );

      results.push(updateRes.ok
        ? { sku: item.sku, status: 'SYNCED', wms_qty: wmsQty }
        : { sku: item.sku, status: 'ERROR', error: (await updateRes.json() as any).message, wms_qty: wmsQty }
      );
    }

    await query(
      `INSERT INTO audit_log (action, entity_type, entity_id, user_id, new_values, created_at)
       VALUES ('MEDUSA_SYNC', 'inventory', 'bulk', $1, $2, NOW())`,
      [(req as any).user?.sub || 'system', JSON.stringify({ count: results.length, synced: results.filter(r => r.status === 'SYNCED').length })]
    ).catch(() => {});

    res.json({
      success: true,
      synced: results.filter(r => r.status === 'SYNCED').length,
      errors: results.filter(r => r.status === 'ERROR').length,
      not_in_medusa: results.filter(r => r.status === 'NOT_IN_MEDUSA').length,
      results,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sync failed', detail: (err as Error).message });
  }
});

// WMS inventory flat list
router.get('/all', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(`
      SELECT wi.product_sku as sku, wi.colour_code as colour, wi.quantity, wl.location_code as location
      FROM warehouse_inventory wi LEFT JOIN warehouse_locations wl ON wl.id = wi.location_id
      ORDER BY wi.product_sku, wi.colour_code
    `);
    res.json({ items: result.rows, count: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

export default router;