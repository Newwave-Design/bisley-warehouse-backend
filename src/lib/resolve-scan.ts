import { query } from '../db/index.js';

/** Codes to try for one scan: the text itself, without a trailing -001, and with slashes written as hyphens. */
export function scanKeys(value: string): string[] {
  const raw = value.trim().toUpperCase();
  if (!raw) return [];
  const stripped = raw.replace(/-001$/, '');
  const hyphen = stripped.replace(/\//g, '-');
  return [...new Set([raw, stripped, hyphen])];
}

export type ResolvedScan = {
  matched: boolean;
  source: 'barcode' | 'product' | 'unmatched';
  sku: string;
  nw_code: string;
  medusa_sku: string | null;
  colour_code: string | null;
  colour_name: string | null;
  product_name: string;
  thumbnail: string | null;
};

/**
 * Resolve a scanned code to a product, including archived ones.
 * When nothing matches, the code is still returned so the scan can be recorded and sorted out later.
 */
export async function resolveScan(raw: string): Promise<ResolvedScan | null> {
  const keys = scanKeys(raw);
  if (!keys.length) return null;
  const q = keys[0];

  const barcode = await query(
    `SELECT bm.product_sku, bm.colour_code, bm.colour_name, bm.product_name, bm.thumbnail_url,
            wp.variant_sku, wp.product_title, wp.colour_name AS wp_colour_name, wp.variant_thumbnail
       FROM barcode_mappings bm
       LEFT JOIN wms_products wp ON upper(wp.variant_sku) = upper(bm.product_sku)
      WHERE upper(bm.barcode) = $1 AND bm.is_active = true
      ORDER BY wp.is_archived ASC NULLS LAST
      LIMIT 1`,
    [q],
  );
  const bar = barcode.rows[0];
  if (bar) {
    const sku = bar.product_sku || bar.variant_sku || q;
    return {
      matched: true,
      source: 'barcode',
      sku,
      nw_code: sku,
      medusa_sku: bar.variant_sku || sku,
      colour_code: bar.colour_code || null,
      colour_name: bar.colour_name || bar.wp_colour_name || null,
      product_name: bar.product_name || bar.product_title || sku,
      thumbnail: bar.thumbnail_url || bar.variant_thumbnail || null,
    };
  }

  const product = await query(
    `SELECT variant_sku, nw_code, colour_code, colour_name, product_title, variant_thumbnail
       FROM wms_products
      WHERE upper(variant_sku) = ANY($1::text[])
         OR upper(coalesce(nw_code, '')) = ANY($1::text[])
      ORDER BY is_archived ASC, (upper(variant_sku) = $2) DESC
      LIMIT 1`,
    [keys, q],
  );
  const row = product.rows[0];
  if (row) {
    return {
      matched: true,
      source: 'product',
      sku: row.variant_sku,
      nw_code: row.nw_code || row.variant_sku,
      medusa_sku: row.variant_sku,
      colour_code: row.colour_code || null,
      colour_name: row.colour_name || null,
      product_name: row.product_title || row.variant_sku,
      thumbnail: row.variant_thumbnail || null,
    };
  }

  const mapped = await query(
    `SELECT s.nw_code, s.medusa_sku, s.colour, s.product_name,
            w.variant_sku, w.colour_code, w.colour_name, w.product_title, w.variant_thumbnail
       FROM sku_mappings s
       LEFT JOIN wms_products w ON upper(w.variant_sku) = upper(s.medusa_sku)
      WHERE upper(s.nw_code) = ANY($1::text[])
      ORDER BY w.is_archived ASC NULLS LAST
      LIMIT 1`,
    [keys],
  );
  const map = mapped.rows[0];
  if (map) {
    const sku = map.variant_sku || map.medusa_sku || map.nw_code;
    return {
      matched: true,
      source: 'product',
      sku,
      nw_code: map.nw_code || sku,
      medusa_sku: map.variant_sku || map.medusa_sku || null,
      colour_code: map.colour_code || null,
      colour_name: map.colour_name || map.colour || null,
      product_name: map.product_title || map.product_name || sku,
      thumbnail: map.variant_thumbnail || null,
    };
  }

  return {
    matched: false,
    source: 'unmatched',
    sku: q,
    nw_code: q,
    medusa_sku: null,
    colour_code: null,
    colour_name: null,
    product_name: 'Not in catalogue',
    thumbnail: null,
  };
}
