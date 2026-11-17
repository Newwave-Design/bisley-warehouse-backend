import { query } from '../db/index.js';
import type { ResolvedScan } from './resolve-scan.js';

/**
 * Remember a scanned code as a product, for every scan after this one.
 * The catalogue sync leaves these rows alone.
 */
export async function assignBarcode(barcode: string, sku: string, assignedBy: string | null): Promise<ResolvedScan | null> {
  const code = barcode.trim();
  const wanted = sku.trim();
  if (!code || !wanted || code.length > 100) return null;

  const product = await query(
    `SELECT variant_sku, product_title, colour_code, colour_name, variant_thumbnail,
            medusa_product_id, medusa_variant_id, is_archived
       FROM wms_products
      WHERE upper(variant_sku) = upper($1)
      ORDER BY is_archived ASC, variant_sku
      LIMIT 1`,
    [wanted],
  );
  const p = product.rows[0];
  if (!p) return null;

  if (p.is_archived) {
    await query(
      `UPDATE wms_products
          SET is_archived = false, archived_at = NULL,
              metadata = COALESCE(metadata, '{}'::jsonb) || '{"keep_for_receiving":"true"}'::jsonb,
              updated_at = NOW()
        WHERE upper(variant_sku) = upper($1)`,
      [p.variant_sku],
    );
  }

  const existing = await query(
    `SELECT product_sku, is_active FROM barcode_mappings WHERE upper(barcode) = upper($1)`,
    [code],
  );
  const taken = existing.rows[0];
  if (taken?.is_active && String(taken.product_sku).toUpperCase() !== String(p.variant_sku).toUpperCase()) {
    return null;
  }

  await query(
    `INSERT INTO barcode_mappings
       (barcode, product_sku, colour_code, colour_name, product_name, thumbnail_url,
        medusa_product_id, medusa_variant_id, assigned_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (barcode) DO UPDATE SET
       product_sku = EXCLUDED.product_sku, colour_code = EXCLUDED.colour_code,
       colour_name = EXCLUDED.colour_name, product_name = EXCLUDED.product_name,
       thumbnail_url = EXCLUDED.thumbnail_url, medusa_product_id = EXCLUDED.medusa_product_id,
       medusa_variant_id = EXCLUDED.medusa_variant_id, is_active = true,
       assigned_by = EXCLUDED.assigned_by, updated_at = NOW()`,
    [code, p.variant_sku, p.colour_code, p.colour_name, p.product_title, p.variant_thumbnail,
      p.medusa_product_id, p.medusa_variant_id, assignedBy],
  );

  await query(
    `INSERT INTO sku_mappings (nw_code, medusa_sku, product_name, colour, status, notes, mapped_at, confidence)
     VALUES ($1, $2, $3, $4, 'VALIDATED', 'Assigned from a delivery scan', NOW(), 1)
     ON CONFLICT (nw_code) DO UPDATE SET
       medusa_sku = EXCLUDED.medusa_sku, product_name = EXCLUDED.product_name,
       colour = EXCLUDED.colour, status = 'VALIDATED', notes = EXCLUDED.notes, updated_at = NOW()`,
    [code, p.variant_sku, p.product_title, p.colour_name],
  );

  return {
    matched: true,
    source: 'barcode',
    sku: p.variant_sku,
    nw_code: p.variant_sku,
    medusa_sku: p.variant_sku,
    colour_code: p.colour_code || null,
    colour_name: p.colour_name || null,
    product_name: p.product_title || p.variant_sku,
    thumbnail: p.variant_thumbnail || null,
  };
}
