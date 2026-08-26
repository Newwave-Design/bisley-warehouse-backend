/**
 * Products API Routes
 *
 * GET  /api/products              — live fetch from Medusa (5-min memory cache)
 * GET  /api/products/wms-cache    — read from local wms_products table
 * POST /api/products/sync         — pull all Medusa products into wms_products + barcode_mappings
 * GET  /api/products/:id          — single product from memory cache
 */

import express, { Response } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { getMedusaToken, MEDUSA_URL } from '../../lib/medusa-client.js';
import { query } from '../../db/index.js';

const router = express.Router();

// ── Bisley colour code → display name lookup ──────────────────────────────────
const COLOUR_NAMES: Record<string, string> = {
  av1: 'Black', aa3: 'Anthracite Grey', ba5: 'Traffic White',
  bc6: 'Bisley Blue', bn6: 'Bisley Orange', bx6: 'Olive Green',
  cb2: 'Palest Pink', cd1: 'Golden Sunflower Yellow', av4: 'Goose Grey',
  ag8: 'Regent', bz2: 'Ocean Blue', cj6: 'Natural Canvas',
  da8: 'Emerald', be2: 'Fuchsia', bh2: 'Bisley Green', bp5: 'Azure',
  ab1: 'Coral', bq4: 'Seville', ab2: 'Lilac', cj4: 'Berry',
  cj5: 'Marine Green', ab9: 'Chalk', ay8: 'Cardinal Red', bp7: 'Prussian',
  bq5: 'Dijon', ay7: 'Oxford Blue',
};

/** Extract Bisley colour code (e.g. av1, bc6) from the end of a SKU. */
function extractColourCode(sku: string): string | null {
  const lastSeg = sku.split('-').pop() ?? '';
  const m = /([a-z]{2}\d)$/.exec(lastSeg);
  return m ? m[1] : null;
}

// ── Interfaces ────────────────────────────────────────────────────────────────
interface KitComponent { sku: string; required_quantity: number }
interface WmsVariant {
  id: string; sku: string; title: string; thumbnail: string | null
  manage_inventory: boolean; is_kit: boolean; kit_components: KitComponent[]
  inventory_qty: number; colour_code: string | null; colour_name: string | null
  allow_backorder: boolean; price_gbp: number | null; barcode: string | null
  weight_grams: number | null; height_mm: number | null; width_mm: number | null; depth_mm: number | null
}
interface WmsProduct {
  id: string; title: string; subtitle: string | null; handle: string; status: string
  thumbnail: string | null; description: string | null; material: string | null
  gallery_images: string[]; metadata: Record<string, any>
  weight_grams: number | null; height_mm: number | null; width_mm: number | null; depth_mm: number | null
  variant_count: number; kit_variant_count: number
  variants: WmsVariant[]
}

// ── 5-min in-memory cache (busted by /sync or ?refresh=true) ──────────────────
let _cache: WmsProduct[] | null = null;
let _cacheExpiry = 0;

async function fetchAllProductsFromMedusa(forceRefresh = false): Promise<WmsProduct[]> {
  if (!forceRefresh && _cache && Date.now() < _cacheExpiry) return _cache;

  const token = await getMedusaToken();
  const auth = { Authorization: `Bearer ${token}` };

  // Inventory qty map: SKU → available_qty
  const inventoryMap = new Map<string, number>();
  let invOff = 0;
  while (true) {
    const d = await fetch(
      `${MEDUSA_URL}/admin/inventory-items?limit=100&offset=${invOff}` +
      `&fields=id,sku,location_levels.available_quantity`,
      { headers: auth }
    ).then(r => r.json()) as any;
    for (const item of d.inventory_items ?? []) {
      const qty = (item.location_levels ?? []).reduce((s: number, l: any) => s + (l.available_quantity ?? 0), 0);
      if (item.sku) inventoryMap.set(item.sku, qty);
    }
    invOff += 100;
    if (invOff >= (d.count ?? 0)) break;
  }

  const products: WmsProduct[] = [];
  let pOff = 0;
  while (true) {
    const d = await fetch(
      `${MEDUSA_URL}/admin/products?limit=100&offset=${pOff}` +
      `&fields=id,title,subtitle,description,handle,status,thumbnail,material,weight,height,width,length,metadata` +
      `,+images,*variants,*variants.inventory_items,*variants.inventory_items.inventory_item,*variants.prices`,
      { headers: auth }
    ).then(r => r.json()) as any;

    for (const p of d.products ?? []) {
      const gallery: string[] = (p.images ?? []).map((img: any) => img.url).filter(Boolean);

      const variants: WmsVariant[] = (p.variants ?? []).map((v: any) => {
        const links: any[] = v.inventory_items ?? [];
        const kit_components = links
          .map((l: any) => ({ sku: l.inventory_item?.sku ?? null, required_quantity: l.required_quantity ?? 1 }))
          .filter(c => c.sku);
        const is_kit = links.length > 1;
        const inventory_qty = is_kit && kit_components.length > 0
          ? Math.min(...kit_components.map(c => Math.floor((inventoryMap.get(c.sku) ?? 0) / c.required_quantity)))
          : inventoryMap.get(v.sku) ?? 0;
        const colour_code = extractColourCode(v.sku ?? '');
        const colour_name = COLOUR_NAMES[colour_code ?? ''] ?? v.title ?? null;
        // Use variant-level dimensions/weight if set, fall back to product-level
        const weight_grams = v.weight ?? p.weight ?? null;
        const height_mm = v.height ?? p.height ?? null;
        const width_mm = v.width ?? p.width ?? null;
        const depth_mm = v.length ?? p.length ?? null;
        // GBP price: find the GBP price entry and convert from stored amount (major units = pounds)
        const gbpPrice = (v.prices ?? []).find((pr: any) => pr.currency_code === 'gbp');
        const price_gbp = gbpPrice ? gbpPrice.amount : null;

        return {
          id: v.id, sku: v.sku ?? '', title: v.title ?? '', thumbnail: v.thumbnail ?? null,
          manage_inventory: !!v.manage_inventory, is_kit, kit_components,
          inventory_qty, colour_code, colour_name,
          allow_backorder: !!v.allow_backorder,
          price_gbp,
          barcode: v.barcode ?? null,
          weight_grams, height_mm, width_mm, depth_mm,
        };
      });

      products.push({
        id: p.id, title: p.title, subtitle: p.subtitle ?? null,
        handle: p.handle, status: p.status,
        thumbnail: p.thumbnail ?? null,
        description: p.description ?? null,
        material: p.material ?? null,
        gallery_images: gallery,
        metadata: p.metadata ?? {},
        weight_grams: p.weight ?? null,
        height_mm: p.height ?? null,
        width_mm: p.width ?? null,
        depth_mm: p.length ?? null,
        variant_count: variants.length,
        kit_variant_count: variants.filter(v => v.is_kit).length,
        variants,
      });
    }
    pOff += 100;
    if (pOff >= (d.count ?? 0)) break;
  }

  _cache = products;
  _cacheExpiry = Date.now() + 5 * 60 * 1000;
  return products;
}

// ── GET /api/products ─────────────────────────────────────────────────────────
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const allProducts = await fetchAllProductsFromMedusa(req.query.refresh === 'true');
    const search = ((req.query.search as string) ?? '').toLowerCase();
    const statusFilter = (req.query.status as string) ?? '';
    let filtered = allProducts;
    if (search) filtered = filtered.filter(p => p.title.toLowerCase().includes(search) || p.handle.includes(search));
    if (statusFilter) filtered = filtered.filter(p => p.status === statusFilter);
    res.json({
      products: filtered,
      total: filtered.length,
      stats: {
        total_products: allProducts.length,
        total_variants: allProducts.reduce((s, p) => s + p.variant_count, 0),
        kit_variants: allProducts.reduce((s, p) => s + p.kit_variant_count, 0),
        published: allProducts.filter(p => p.status === 'published').length,
      },
    });
  } catch (err) {
    console.error('Products fetch error:', err);
    res.status(503).json({ error: 'Could not fetch products from Medusa', detail: (err as Error).message });
  }
});

// ── GET /api/products/wms-cache ───────────────────────────────────────────────
router.get('/wms-cache', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const search = ((req.query.search as string) ?? '').toLowerCase();
    const statusFilter = (req.query.status as string) ?? '';

    // GROUP BY product only — MAX() is safe since product-level columns are identical per product
    let sql = `
      SELECT
        medusa_product_id,
        MAX(product_title)                              AS product_title,
        MAX(product_subtitle)                           AS product_subtitle,
        MAX(product_handle)                             AS product_handle,
        MAX(product_status)                             AS product_status,
        MAX(product_thumbnail)                          AS product_thumbnail,
        MAX(product_description)                        AS product_description,
        MAX(product_material)                           AS product_material,
        MAX(COALESCE(gallery_images::text, '[]'))::jsonb AS gallery_images,
        MAX(COALESCE(metadata::text, '{}'))::jsonb      AS metadata,
        MAX(weight_grams)                               AS weight_grams,
        MAX(height_mm)                                  AS height_mm,
        MAX(width_mm)                                   AS width_mm,
        MAX(depth_mm)                                   AS depth_mm,
        COUNT(*)::int                                   AS variant_count,
        COUNT(*) FILTER (WHERE is_kit)::int             AS kit_variant_count,
        json_agg(json_build_object(
          'id',              medusa_variant_id,
          'sku',             variant_sku,
          'title',           variant_title,
          'colour_code',     colour_code,
          'colour_name',     colour_name,
          'thumbnail',       variant_thumbnail,
          'manage_inventory', manage_inventory,
          'allow_backorder', COALESCE(allow_backorder, false),
          'price_gbp',       price_gbp,
          'barcode',         variant_barcode,
          'weight_grams',    COALESCE(variant_weight_grams, weight_grams),
          'is_kit',          is_kit,
          'kit_components',  kit_components,
          'inventory_qty',   inventory_qty
        ) ORDER BY variant_sku) AS variants,
        MAX(last_synced_at) AS last_synced_at
      FROM wms_products WHERE 1=1`;
    const params: any[] = [];
    let pi = 1;
    if (search) {
      sql += ` AND (product_title ILIKE $${pi} OR product_handle ILIKE $${pi} OR variant_sku ILIKE $${pi})`;
      params.push(`%${search}%`); pi++;
    }
    if (statusFilter) { sql += ` AND product_status = $${pi}`; params.push(statusFilter); pi++; }
    sql += ` GROUP BY medusa_product_id ORDER BY MAX(product_title)`;

    const [result, statsResult] = await Promise.all([
      query(sql, params),
      query(`SELECT COUNT(DISTINCT medusa_product_id)::int AS total_products,
                    COUNT(*)::int AS total_variants,
                    COUNT(*) FILTER (WHERE is_kit)::int AS kit_variants,
                    COUNT(DISTINCT medusa_product_id) FILTER (WHERE product_status='published')::int AS published,
                    MAX(last_synced_at) AS last_synced_at
             FROM wms_products`),
    ]);

    res.json({
      products: result.rows.map(row => ({
        id: row.medusa_product_id,
        title: row.product_title,
        subtitle: row.product_subtitle ?? null,
        handle: row.product_handle,
        status: row.product_status,
        thumbnail: row.product_thumbnail,
        description: row.product_description ?? null,
        material: row.product_material ?? null,
        gallery_images: row.gallery_images ?? [],
        metadata: row.metadata ?? {},
        weight_grams: row.weight_grams ?? null,
        height_mm: row.height_mm ?? null,
        width_mm: row.width_mm ?? null,
        depth_mm: row.depth_mm ?? null,
        variant_count: row.variant_count,
        kit_variant_count: row.kit_variant_count,
        variants: row.variants ?? [],
        last_synced_at: row.last_synced_at,
      })),
      total: result.rows.length,
      stats: statsResult.rows[0] ?? null,
    });
  } catch (err) {
    console.error('WMS cache read error:', err);
    res.status(500).json({ error: 'Failed to read WMS product cache', detail: (err as Error).message });
  }
});

// ── POST /api/products/sync ───────────────────────────────────────────────────
router.post('/sync', authMiddleware, async (req: AuthRequest, res: Response) => {
  const syncStart = new Date();
  const startedAt = Date.now();
  let inserted = 0, updated = 0, skipped = 0, barcodesSynced = 0;
  const errors: string[] = [];

  try {
    // Always fetch fresh data from Medusa — never use cached data for a sync
    const allProducts = await fetchAllProductsFromMedusa(true);

    for (const product of allProducts) {
      for (const v of product.variants) {
        // Skip variants without a SKU — they can't be tracked in the WMS
        if (!v.sku) { skipped++; continue; }

        try {
          const kitJson = JSON.stringify(v.kit_components);

          const r = await query(`
            INSERT INTO wms_products
              (medusa_product_id, medusa_variant_id,
               product_title, product_subtitle, product_handle, product_status, product_thumbnail,
               product_description, product_material, gallery_images, metadata,
               weight_grams, height_mm, width_mm, depth_mm,
               variant_sku, variant_title, colour_code, colour_name, variant_thumbnail,
               manage_inventory, allow_backorder, price_gbp, variant_barcode,
               variant_weight_grams, variant_height_mm, variant_width_mm, variant_depth_mm,
               is_kit, kit_components, inventory_qty, last_synced_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,
                    $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30::jsonb,$31,NOW())
            ON CONFLICT (medusa_variant_id) DO UPDATE SET
              product_title       = EXCLUDED.product_title,
              product_subtitle    = EXCLUDED.product_subtitle,
              product_handle      = EXCLUDED.product_handle,
              product_status      = EXCLUDED.product_status,
              product_thumbnail   = EXCLUDED.product_thumbnail,
              product_description = EXCLUDED.product_description,
              product_material    = EXCLUDED.product_material,
              gallery_images      = EXCLUDED.gallery_images,
              metadata            = EXCLUDED.metadata,
              weight_grams        = EXCLUDED.weight_grams,
              height_mm           = EXCLUDED.height_mm,
              width_mm            = EXCLUDED.width_mm,
              depth_mm            = EXCLUDED.depth_mm,
              variant_sku         = EXCLUDED.variant_sku,
              variant_title       = EXCLUDED.variant_title,
              colour_code         = EXCLUDED.colour_code,
              colour_name         = EXCLUDED.colour_name,
              variant_thumbnail   = EXCLUDED.variant_thumbnail,
              manage_inventory    = EXCLUDED.manage_inventory,
              allow_backorder     = EXCLUDED.allow_backorder,
              price_gbp           = EXCLUDED.price_gbp,
              variant_barcode     = EXCLUDED.variant_barcode,
              variant_weight_grams = EXCLUDED.variant_weight_grams,
              variant_height_mm   = EXCLUDED.variant_height_mm,
              variant_width_mm    = EXCLUDED.variant_width_mm,
              variant_depth_mm    = EXCLUDED.variant_depth_mm,
              is_kit              = EXCLUDED.is_kit,
              kit_components      = EXCLUDED.kit_components,
              inventory_qty       = EXCLUDED.inventory_qty,
              last_synced_at      = NOW(),
              updated_at          = NOW()
            RETURNING (xmax = 0) AS is_insert
          `, [
            product.id, v.id,
            product.title, product.subtitle, product.handle, product.status, product.thumbnail,
            product.description, product.material,
            JSON.stringify(product.gallery_images), JSON.stringify(product.metadata),
            product.weight_grams, product.height_mm, product.width_mm, product.depth_mm,
            v.sku, v.title, v.colour_code, v.colour_name, v.thumbnail,
            v.manage_inventory, v.allow_backorder, v.price_gbp, v.barcode,
            v.weight_grams, v.height_mm, v.width_mm, v.depth_mm,
            v.is_kit, kitJson, v.inventory_qty,
          ]);
          if (r.rows[0]?.is_insert) inserted++; else updated++;

          // Keep barcode_mappings in sync for the scanning workflow
          if (v.sku) {
            await query(`
              INSERT INTO barcode_mappings
                (barcode, product_sku, colour_code, colour_name, product_name,
                 thumbnail_url, medusa_product_id, medusa_variant_id)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
              ON CONFLICT (barcode) DO UPDATE SET
                product_sku       = EXCLUDED.product_sku,
                colour_code       = EXCLUDED.colour_code,
                colour_name       = EXCLUDED.colour_name,
                product_name      = EXCLUDED.product_name,
                thumbnail_url     = EXCLUDED.thumbnail_url,
                medusa_product_id = EXCLUDED.medusa_product_id,
                medusa_variant_id = EXCLUDED.medusa_variant_id,
                updated_at        = NOW()
            `, [
              v.sku, v.sku, v.colour_code, v.colour_name, product.title,
              v.thumbnail ?? product.thumbnail, product.id, v.id,
            ]);
            barcodesSynced++;
          }
        } catch (err: any) {
          errors.push(`${v.sku}: ${err.message?.slice(0, 80)}`);
        }
      }
    }

    // Enrich sku_mappings rows where medusa_sku matches a synced variant
    const enrichResult = await query(`
      UPDATE sku_mappings sm
      SET product_name = wmp.product_title,
          colour       = wmp.colour_name,
          updated_at   = NOW()
      FROM wms_products wmp
      WHERE sm.medusa_sku = wmp.variant_sku
        AND sm.medusa_sku IS NOT NULL
    `);

    // Detect stale rows — variants that existed before this sync but weren't touched.
    // These are products/variants that have been removed from Medusa since last sync.
    const staleResult = await query(
      `SELECT COUNT(*)::int AS stale_count FROM wms_products WHERE last_synced_at < $1`,
      [syncStart]
    );
    const staleCount = staleResult.rows[0]?.stale_count ?? 0;

    res.json({
      inserted,
      updated,
      skipped,
      barcodes_synced: barcodesSynced,
      sku_mappings_enriched: enrichResult.rowCount ?? 0,
      stale_rows: staleCount, // rows not seen in Medusa this sync — may have been deleted
      errors: errors.slice(0, 20),
      duration_ms: Date.now() - startedAt,
      total_variants: inserted + updated,
    });
  } catch (err: any) {
    console.error('Sync error:', err);
    res.status(500).json({ error: 'Sync failed', detail: err.message, inserted, updated, errors });
  }
});

// ── GET /api/products/:id ─────────────────────────────────────────────────────
router.get('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const products = await fetchAllProductsFromMedusa();
    const product = products.find(p => p.id === req.params.id || p.handle === req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ product });
  } catch (err) {
    res.status(503).json({ error: 'Could not fetch product', detail: (err as Error).message });
  }
});

export default router;
