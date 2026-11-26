/**
 * Periodic inventory discrepancy check — what the shop should be selling vs what Medusa is set to.
 * The shop sells stock not reserved to any existing order: Medusa's stocked quantity should be what can be sold
 * plus Medusa's own reservations (see shop-stock.ts). A SKU whose stocked quantity is not that is a mismatch.
 * Logs mismatches to wms_error_log (source DISCREPANCY_CHECK) so they surface in
 * the Error Log dashboard. Self-heals: auto-resolves stale entries once a SKU's
 * quantities agree again, and skips re-logging an already-open, unchanged mismatch.
 *
 * Run on a schedule from server.ts, or on demand via POST /api/error-log/check-discrepancies.
 */
import { query } from '../db/index.js';
import { getMedusaHeaders } from './medusa-inventory.js';
import { shopStockTarget } from './shop-stock.js';
import { pooledTrayQty, trayMate } from './tray-pool.js';
import { logWarning } from './logger.js';

const MEDUSA_URL = process.env.MEDUSA_API_BASE_URL || 'https://bisley-shop.medusajs.app';
const LOCATION_ID = process.env.MEDUSA_LOCATION_ID || 'sloc_01KY7PZB8JRYF31JPJ6EYQD8DJ';

async function fetchMedusaQuantities(): Promise<Map<string, { stocked: number; reserved: number }>> {
  const headers = getMedusaHeaders();
  const qtyMap = new Map<string, { stocked: number; reserved: number }>();
  let offset = 0;
  while (true) {
    const res = await fetch(
      `${MEDUSA_URL}/admin/inventory-items?limit=100&offset=${offset}&fields=id,sku,*location_levels`,
      { headers }
    );
    if (!res.ok) throw new Error(`Medusa stock read failed (${res.status}); the discrepancy check was not run`);
    const data = await res.json() as any;
    for (const item of data.inventory_items ?? []) {
      if (!item.sku) continue;
      const level = item.location_levels?.find((l: any) => l.location_id === LOCATION_ID) ?? item.location_levels?.[0];
      if (level) qtyMap.set(item.sku, { stocked: level.stocked_quantity ?? 0, reserved: level.reserved_quantity ?? 0 });
    }
    offset += 100;
    if (offset >= (data.count ?? 0) || !data.inventory_items?.length) break;
  }
  return qtyMap;
}

export interface DiscrepancyResult {
  checked: number;
  mismatches: number;
  newlyLogged: number;
  autoResolved: number;
}

export async function runDiscrepancyCheck(): Promise<DiscrepancyResult> {
  const wmsRows = await query(`SELECT product_sku AS sku, SUM(quantity)::int AS onhand, SUM(quantity_available)::int AS free FROM warehouse_inventory GROUP BY product_sku`);
  const ownStock = new Map<string, { onhand: number; free: number }>(wmsRows.rows.map((r: any) => [r.sku, { onhand: r.onhand, free: r.free }]));
  // Insert-tray singles and 5-packs are one pool, as in the shop sync, so each is checked against what it can sell as that form.
  const wmsStock = new Map<string, { onhand: number; free: number }>();
  for (const [sku, own] of ownStock) {
    const mate = trayMate(sku);
    const other = mate ? ownStock.get(mate) : undefined;
    wmsStock.set(sku, mate ? { onhand: pooledTrayQty(sku, own.onhand, other?.onhand ?? 0), free: pooledTrayQty(sku, own.free, other?.free ?? 0) } : own);
  }
  // A tray form with no stock of its own still sells from the pool.
  for (const sku of ownStock.keys()) {
    const mate = trayMate(sku);
    if (mate && !wmsStock.has(mate)) {
      const other = ownStock.get(sku)!;
      wmsStock.set(mate, { onhand: pooledTrayQty(mate, 0, other.onhand), free: pooledTrayQty(mate, 0, other.free) });
    }
  }
  const medusaMap = await fetchMedusaQuantities();

  // Existing open discrepancy entries, keyed by sku, so we can compare/auto-resolve
  const openRows = await query(
    `SELECT id, context->>'sku' AS sku, (context->>'wms_qty')::int AS wms_qty, (context->>'medusa_qty')::int AS medusa_qty
     FROM wms_error_log WHERE source='DISCREPANCY_CHECK' AND resolved=false`
  );
  const openBySkus = new Map<string, { id: string; wms_qty: number; medusa_qty: number }>();
  for (const r of openRows.rows) openBySkus.set(r.sku, { id: r.id, wms_qty: r.wms_qty, medusa_qty: r.medusa_qty });

  const allSkus = new Set([...wmsStock.keys(), ...medusaMap.keys()]);
  let mismatches = 0, newlyLogged = 0, autoResolved = 0;

  for (const sku of allSkus) {
    const level = medusaMap.get(sku); // undefined = no Medusa inventory item for this SKU
    const stock = wmsStock.get(sku) ?? { onhand: 0, free: 0 };
    // What Medusa should hold: what can be sold plus its own reservations. wmsQty is that expected figure, medusaQty what Medusa holds.
    const wmsQty = level ? shopStockTarget({ free: stock.free, onhand: stock.onhand, medusaReserved: level.reserved }).stocked : stock.onhand;
    const medusaQty = level?.stocked;
    const existing = openBySkus.get(sku);

    const isMismatch = medusaQty !== undefined && wmsQty !== medusaQty;

    if (isMismatch) {
      mismatches++;
      if (existing && existing.wms_qty === wmsQty && existing.medusa_qty === medusaQty) {
        continue; // same mismatch already open — don't spam
      }
      if (existing) {
        // Values changed since last check — close the stale entry, log a fresh one
        await query(`UPDATE wms_error_log SET resolved=true, resolved_at=NOW(), resolved_by='system-auto' WHERE id=$1`, [existing.id]);
        autoResolved++;
      }
      await logWarning('DISCREPANCY_CHECK', `Shop stock for ${sku} should be set to ${wmsQty} (what can be sold plus Medusa reservations) but Medusa holds ${medusaQty}`, {
        sku, wms_qty: wmsQty, medusa_qty: medusaQty, diff: wmsQty - (medusaQty as number),
      });
      newlyLogged++;
    } else if (existing) {
      // Was mismatched, now agrees — auto-resolve
      await query(`UPDATE wms_error_log SET resolved=true, resolved_at=NOW(), resolved_by='system-auto' WHERE id=$1`, [existing.id]);
      autoResolved++;
    }
  }

  return { checked: allSkus.size, mismatches, newlyLogged, autoResolved };
}
