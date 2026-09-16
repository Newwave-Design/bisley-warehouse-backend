/**
 * Inventory Sync API — Phases 6 & 7
 * Phase 6: Pre-sync comparison (WMS vs Medusa)
 * Phase 7: Push WMS quantities to Medusa
 */

import express, { Request, Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, requirePermission, AuthRequest } from '../../middleware/auth.js';

const router = express.Router();

const MEDUSA_URL = process.env.MEDUSA_API_BASE_URL || 'https://bisley-shop.medusajs.app';
const MEDUSA_API_KEY = process.env.MEDUSA_SECRET_API_KEY;
if (!MEDUSA_API_KEY) throw new Error('MEDUSA_SECRET_API_KEY env var is not set');
// Medusa has 2 stock locations (European Warehouse + an unused legacy "Ovara" location with
// no sales channel). Every inventory lookup MUST filter to this one or quantities double-count.
const LOCATION_ID = process.env.MEDUSA_LOCATION_ID || 'sloc_01KY792H831KT3TKH4CYPF7FT9';

function getMedusaHeaders(): Record<string, string> {
  return {
    'Authorization': `Bearer ${MEDUSA_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

// 10-minute in-memory cache for Medusa inventory (avoids 60s Medusa API round-trips)
let _inventoryCache: Map<string, number> | null = null;
let _inventoryCacheExpiry = 0;

async function fetchMedusaInventory(forceRefresh = false): Promise<Map<string, number>> {
  if (!forceRefresh && _inventoryCache && Date.now() < _inventoryCacheExpiry) {
    return _inventoryCache;
  }
  const headers = getMedusaHeaders();
  const qtyMap = new Map<string, number>();
  let offset = 0;
  while (true) {
    const res = await fetch(
      `${MEDUSA_URL}/admin/inventory-items?limit=100&offset=${offset}&fields=id,sku,*location_levels`,
      { headers }
    );
    const data = await res.json() as any;
    for (const item of data.inventory_items ?? []) {
      const level = item.location_levels?.find((l: any) => l.location_id === LOCATION_ID);
      if (item.sku) qtyMap.set(item.sku, level?.available_quantity ?? 0);
    }
    offset += 100;
    if (offset >= (data.count ?? 0)) break;
  }
  _inventoryCache = qtyMap;
  _inventoryCacheExpiry = Date.now() + 10 * 60 * 1000; // 10 min TTL
  return qtyMap;
}

async function getMedusaItemInfo(sku: string): Promise<{ itemId: string; locationId: string } | null> {
  const headers = getMedusaHeaders();
  const res = await fetch(
    `${MEDUSA_URL}/admin/inventory-items?sku=${encodeURIComponent(sku)}&fields=id,sku,*location_levels`,
    { headers }
  );
  const data = await res.json() as any;
  const item = data.inventory_items?.[0];
  const level = item?.location_levels?.find((l: any) => l.location_id === LOCATION_ID) ?? item?.location_levels?.[0];
  return level ? { itemId: item.id, locationId: level.location_id } : null;
}

// Pre-sync comparison � Medusa is the source of truth; WMS defaults to 0 if not stocked
router.get('/pre-sync', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    // Fetch Medusa inventory first � uses 10-min cache; pass ?refresh=true to force reload
    let medusaMap: Map<string, number>;
    try {
      medusaMap = await fetchMedusaInventory(forceRefresh);
    } catch (err) {
      return res.status(503).json({ error: 'Could not reach Medusa API', detail: (err as Error).message });
    }

    if (medusaMap.size === 0) {
      return res.json({ items: [], total: 0, diffs: 0, in_sync: 0, message: 'No inventory found in Medusa.' });
    }

    // Build WMS totals per SKU (may be empty if nothing stocked yet)
    const wmsResult = await query(`
      SELECT product_sku as sku, SUM(quantity) as wms_qty
      FROM warehouse_inventory GROUP BY product_sku
    `);
    const wmsMap = new Map<string, number>();
    wmsResult.rows.forEach(r => wmsMap.set(r.sku, parseInt(r.wms_qty)));

    // Build items from Medusa as the authoritative list
    const items = Array.from(medusaMap.entries()).map(([sku, medusaQty]) => {
      const wmsQty = wmsMap.get(sku) ?? 0;
      return { sku, colour: null, wms_qty: wmsQty, medusa_qty: medusaQty, diff: wmsQty - medusaQty, in_medusa: true };
    }).sort((a, b) => a.sku.localeCompare(b.sku));

    res.json({ items, total: items.length, diffs: items.filter(i => i.diff !== 0).length, in_sync: items.filter(i => i.diff === 0).length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Pre-sync comparison failed' });
  }
});

// ⚠️ REMOVED: POST /api/inventory/sync
// This endpoint was removed in Phase 3 event-driven refactor.
// Inventory sync now happens ONLY via webhooks (order.placed → reserve, fulfilled → deduct).
// See BACKORDER_FLOW_ANALYSIS.md and MEDUSA_WMS_INTEGRATION.md for architecture.

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

// ?? REMOVED: POST /api/inventory/seed-from-medusa
// This endpoint was removed in Phase 3 refactor.
// Initial SKU/product import now uses POST /api/products/sync (imports product definitions, not inventory quantities).
// Warehouse inventory is populated via receiving (checked in by warehouse staff), never from Medusa.
// See INVENTORY_SYNC_ENDPOINTS_AUDIT.md for details.

// ?? REMOVED: DELETE /api/inventory/wms-inventory
// This endpoint was removed in Phase 3 refactor.
// Was only used to clear IMPORT-01 baseline from seed-from-medusa (which was also removed).
// To clean up test data, use POST /api/inventory/purge-skus instead (deletes specific SKUs).

// Purge specific legacy/phantom SKUs from warehouse_inventory � used to clean up
// old test data (renamed/typo'd product codes) that no longer has a Medusa counterpart.
// Body: { skus: string[] }
router.post('/purge-skus', authMiddleware, requirePermission('system_admin'), async (req: AuthRequest, res: Response) => {
  try {
    const { skus } = req.body as { skus?: string[] };
    if (!Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({ error: 'skus array required' });
    }
    const result = await query(
      `DELETE FROM warehouse_inventory WHERE product_sku = ANY($1::text[]) RETURNING product_sku`,
      [skus]
    );
    res.json({ success: true, deleted: result.rowCount, skus: result.rows.map(r => r.product_sku) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to purge SKUs' });
  }
});

export default router;


