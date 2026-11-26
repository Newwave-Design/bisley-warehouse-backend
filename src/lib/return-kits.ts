/**
 * A kit comes back as the parts that are returning, not as one kit code: a kit has no bin of its own, so putting
 * "the kit" into a bay would be wrong stock. A return line for a kit is split into its parts here. Parts that are
 * not coming back are taken off the return afterwards.
 */
import { query } from '../db/index.js';
import { kitParts } from './stock-holds.js';

export type ReturnLine = { sku: string; qty: number };

/** The lines a returned SKU becomes: its parts if it is a kit, otherwise itself. */
export async function splitKitForReturn(sku: string, qty: number): Promise<ReturnLine[]> {
  const units = Math.max(1, Math.trunc(Number(qty)) || 1);
  const found = await query(
    `SELECT is_kit, kit_components FROM wms_products WHERE variant_sku = $1 ORDER BY COALESCE(is_archived, false) LIMIT 1`,
    [sku]
  );
  const row = found.rows[0];
  if (!row || !row.is_kit) return [{ sku, qty: units }];
  const parts = kitParts(sku, row.kit_components);
  if (!parts.length) return [{ sku, qty: units }];
  return parts.map((part) => ({ sku: part.sku, qty: part.per * units }));
}
