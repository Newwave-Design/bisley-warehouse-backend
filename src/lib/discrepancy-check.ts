/**
 * Periodic inventory discrepancy check — WMS physical stock vs Medusa stocked_quantity.
 * Logs mismatches to wms_error_log (source DISCREPANCY_CHECK) so they surface in
 * the Error Log dashboard. Self-heals: auto-resolves stale entries once a SKU's
 * quantities agree again, and skips re-logging an already-open, unchanged mismatch.
 *
 * Run on a schedule from server.ts, or on demand via POST /api/error-log/check-discrepancies.
 */
import { query } from '../db/index.js';
import { getMedusaToken } from './medusa-inventory.js';
import { logWarning } from './logger.js';

const MEDUSA_URL = process.env.MEDUSA_API_BASE_URL || 'https://bisley-shop.medusajs.app';
const LOCATION_ID = process.env.MEDUSA_LOCATION_ID || 'sloc_01KY792H831KT3TKH4CYPF7FT9';

async function fetchMedusaQuantities(): Promise<Map<string, number>> {
  const token = await getMedusaToken();
  const qtyMap = new Map<string, number>();
  let offset = 0;
  while (true) {
    const res = await fetch(
      `${MEDUSA_URL}/admin/inventory-items?limit=100&offset=${offset}&fields=id,sku,*location_levels`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json() as any;
    for (const item of data.inventory_items ?? []) {
      if (!item.sku) continue;
      const level = item.location_levels?.find((l: any) => l.location_id === LOCATION_ID) ?? item.location_levels?.[0];
      if (level) qtyMap.set(item.sku, level.stocked_quantity ?? 0);
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
  const wmsRows = await query(`SELECT product_sku AS sku, SUM(quantity)::int AS qty FROM warehouse_inventory GROUP BY product_sku`);
  const wmsMap = new Map<string, number>(wmsRows.rows.map((r: any) => [r.sku, r.qty]));
  const medusaMap = await fetchMedusaQuantities();

  // Existing open discrepancy entries, keyed by sku, so we can compare/auto-resolve
  const openRows = await query(
    `SELECT id, context->>'sku' AS sku, (context->>'wms_qty')::int AS wms_qty, (context->>'medusa_qty')::int AS medusa_qty
     FROM wms_error_log WHERE source='DISCREPANCY_CHECK' AND resolved=false`
  );
  const openBySkus = new Map<string, { id: string; wms_qty: number; medusa_qty: number }>();
  for (const r of openRows.rows) openBySkus.set(r.sku, { id: r.id, wms_qty: r.wms_qty, medusa_qty: r.medusa_qty });

  const allSkus = new Set([...wmsMap.keys(), ...medusaMap.keys()]);
  let mismatches = 0, newlyLogged = 0, autoResolved = 0;

  for (const sku of allSkus) {
    const wmsQty = wmsMap.get(sku) ?? 0;
    const medusaQty = medusaMap.get(sku); // undefined = no Medusa inventory item for this SKU
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
      await logWarning('DISCREPANCY_CHECK', `Quantity mismatch for ${sku}: WMS=${wmsQty} vs Medusa=${medusaQty}`, {
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
