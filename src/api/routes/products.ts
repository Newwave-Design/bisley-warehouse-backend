/**
 * Products API Routes
 *
 * GET  /api/products              — live fetch from Medusa (5-min memory cache)
 * GET  /api/products/wms-cache    — read from local wms_products table
 * POST /api/products/sync         — pull all Medusa products into wms_products + barcode_mappings
 * GET  /api/products/:id          — single product from memory cache
 */

import express, { Response } from 'express';
import { authMiddleware, requireRole, AuthRequest } from '../../middleware/auth.js';
import { getMedusaToken, MEDUSA_URL } from '../../lib/medusa-client.js';
import { query } from '../../db/index.js';
import { estimateShippingForServices, resolveKitDimensions, type PackagingProfile, type ShippingService } from '../../lib/shipping-estimator.js';
import { DEFAULT_PACKAGING_PROFILES, DEFAULT_SHIPPING_SERVICES, isMissingRelationError } from '../../lib/fulfillment-defaults.js';
import { getCachedUpsRates, upsReferenceDestinationConfigured, type UpsRateQuote } from '../../lib/ups.js';

const router = express.Router();


// Medusa has 2 stock locations (European Warehouse + an unused legacy "Ovara" location with
// no sales channel). Every inventory lookup MUST filter to this one or quantities double-count.
const LOCATION_ID = process.env.MEDUSA_LOCATION_ID || 'sloc_01KY792H831KT3TKH4CYPF7FT9';

// ── Bisley colour code → display name lookup ──────────────────────────────────
const COLOUR_NAMES: Record<string, string> = {
  av1: 'Black', aa3: 'Anthracite Grey', ba5: 'Traffic White',
  bc6: 'Bisley Blue', bn6: 'Bisley Orange', bx6: 'Olive Green',
  cb2: 'Palest Pink', cd1: 'Golden Sunflower Yellow', av4: 'Goose Grey',
  ag8: 'Regent', bz2: 'Ocean Blue', cj6: 'Natural Canvas',
  da8: 'Emerald', be2: 'Fuchsia', bh2: 'Bisley Green', bp5: 'Azure',
  ab1: 'Coral', bq4: 'Seville', ab2: 'Lilac', cj4: 'Berry',
  cj5: 'Marine Green', ab9: 'Chalk', ay8: 'Cardinal Red', bp7: 'Prussian',
  bq5: 'Dijon', ay7: 'Ocean Blue',
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

interface FulfillmentProfileRow {
  product_sku: string;
  packaging_profile_code: string | null;
  preferred_service_code: string | null;
  requires_manual_review: boolean;
  is_fragile: boolean;
  is_multi_box: boolean;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function withServiceConstraintDefaults(service: ShippingService): ShippingService {
  const c = { ...(service.constraints ?? {}) };
  if (service.courier_code.toLowerCase() === 'ups') {
    // UPS small package defaults (used when admin constraints are incomplete)
    if (c.max_weight_kg == null) c.max_weight_kg = 70;
    if (c.max_length_mm == null) c.max_length_mm = 2740;
    if (c.max_girth_plus_length_mm == null) c.max_girth_plus_length_mm = 4000;
  }
  return { ...service, constraints: c };
}

// ── 5-min in-memory cache (busted by /sync or ?refresh=true) ──────────────────
let _cache: WmsProduct[] | null = null;
let _cacheExpiry = 0;

async function fetchAllProductsFromMedusa(forceRefresh = false): Promise<WmsProduct[]> {
  if (!forceRefresh && _cache && Date.now() < _cacheExpiry) return _cache;

  const token = await getMedusaToken();
  const auth = { Authorization: `Bearer ${token}` };

  // Inventory maps: sku→qty and itemId→sku (needed for kit component SKU resolution)
  const inventoryMap = new Map<string, number>();
  const itemIdToSku = new Map<string, string>();
  let invOff = 0;
  while (true) {
    const d = await fetch(
      `${MEDUSA_URL}/admin/inventory-items?limit=100&offset=${invOff}` +
      `&fields=id,sku,*location_levels`,
      { headers: auth }
    ).then(r => r.json()) as any;
    for (const item of d.inventory_items ?? []) {
      const level = item.location_levels?.find((l: any) => l.location_id === LOCATION_ID);
      const qty = level?.available_quantity ?? 0;
      if (item.sku) {
        inventoryMap.set(item.sku, qty);
        itemIdToSku.set(item.id, item.sku);
      }
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
          .map((l: any) => ({
            // Medusa v2 doesn't deep-expand inventory_item.sku in product queries — use itemIdToSku map
            sku: l.inventory_item?.sku ?? itemIdToSku.get(l.inventory_item_id) ?? null,
            required_quantity: l.required_quantity ?? 1,
          }))
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

// ── In-memory sync state (single-instance; survives for the lifetime of the process) ──
interface SyncState {
  running: boolean;
  started_at: Date | null;
  finished_at: Date | null;
  progress: string;
  result: Record<string, any> | null;
  error: string | null;
}
const syncState: SyncState = {
  running: false, started_at: null, finished_at: null,
  progress: 'idle', result: null, error: null,
};

async function runSyncJob() {
  const syncStart = new Date();
  let inserted = 0, updated = 0, skipped = 0, barcodesSynced = 0;
  const errors: string[] = [];

  try {
    syncState.progress = 'Fetching from Medusa…';
    const allProducts = await fetchAllProductsFromMedusa(true);

    syncState.progress = `Writing ${allProducts.reduce((s, p) => s + p.variant_count, 0)} variants to DB…`;

    for (const product of allProducts) {
      for (const v of product.variants) {
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

    const enrichResult = await query(`
      UPDATE sku_mappings sm
      SET product_name = wmp.product_title,
          colour       = wmp.colour_name,
          updated_at   = NOW()
      FROM wms_products wmp
      WHERE sm.medusa_sku = wmp.variant_sku AND sm.medusa_sku IS NOT NULL
    `);

    const staleResult = await query(
      `SELECT COUNT(*)::int AS stale_count FROM wms_products WHERE last_synced_at < $1`,
      [syncStart]
    );

    syncState.result = {
      inserted, updated, skipped,
      barcodes_synced: barcodesSynced,
      sku_mappings_enriched: enrichResult.rowCount ?? 0,
      stale_rows: staleResult.rows[0]?.stale_count ?? 0,
      errors: errors.slice(0, 20),
      duration_ms: Date.now() - syncStart.getTime(),
      total_variants: inserted + updated,
    };
    syncState.error = null;
  } catch (err: any) {
    console.error('Sync job error:', err);
    syncState.error = err.message;
    syncState.result = { inserted, updated, errors };
  } finally {
    syncState.running = false;
    syncState.finished_at = new Date();
    syncState.progress = syncState.error ? 'failed' : 'complete';
  }
}

// ── POST /api/products/sync — responds immediately, runs in background ─────────
// Idempotent read-only-from-Medusa + upsert — safe for MANAGER, unlike destructive purge/wipe routes.
router.post('/sync', authMiddleware, requireRole(['MANAGER','ADMIN']), (req: AuthRequest, res: Response) => {
  if (syncState.running) {
    return res.status(409).json({
      error: 'Sync already in progress',
      progress: syncState.progress,
      started_at: syncState.started_at,
    });
  }
  syncState.running = true;
  syncState.started_at = new Date();
  syncState.finished_at = null;
  syncState.result = null;
  syncState.error = null;
  syncState.progress = 'Starting…';

  // Fire and forget — response is sent before sync completes to avoid Railway timeout
  res.json({ status: 'started', message: 'Sync running in background. Poll GET /api/products/sync/status' });

  runSyncJob();
});

// ── GET /api/products/sync/status — poll this after triggering a sync ─────────
router.get('/sync/status', authMiddleware, (_req: AuthRequest, res: Response) => {
  res.json({
    running: syncState.running,
    progress: syncState.progress,
    started_at: syncState.started_at,
    finished_at: syncState.finished_at,
    result: syncState.result,
    error: syncState.error,
  });
});

// ── GET /api/products/:id/shipping-estimates ─────────────────────────────────
// Reads dimensions/weight from the local wms_products cache (Neon) — no live Medusa login required.
router.get('/:id/shipping-estimates', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const productRows = await query(
      `SELECT medusa_product_id, product_title, product_handle,
              medusa_variant_id, variant_sku, variant_title, colour_name,
              is_kit, COALESCE(kit_components::text, '[]') AS kit_components,
              COALESCE(variant_weight_grams, weight_grams) AS weight_grams,
              COALESCE(variant_depth_mm, depth_mm) AS depth_mm,
              COALESCE(variant_width_mm, width_mm) AS width_mm,
              COALESCE(variant_height_mm, height_mm) AS height_mm,
              price_gbp
       FROM wms_products
       WHERE medusa_product_id = $1 OR product_handle = $1
       ORDER BY variant_sku`,
      [req.params.id]
    );
    if (!productRows.rows.length) {
      return res.status(404).json({ error: 'Product not found in WMS cache. Run a product sync first.' });
    }

    const product = {
      id: productRows.rows[0].medusa_product_id,
      handle: productRows.rows[0].product_handle,
      title: productRows.rows[0].product_title,
    };
    const variantRows = productRows.rows;

    const skuList = variantRows.map((v: any) => v.variant_sku).filter(Boolean);

    // Kit variants (e.g. MultiDesk) carry no dims of their own — gather every component SKU across
    // this product's kit variants in one batched lookup so we can compute stacked-in-a-box dims.
    const kitComponentSkus = Array.from(new Set(
      variantRows.flatMap((v: any) => v.is_kit ? (JSON.parse(v.kit_components) as { sku: string }[]).map(c => c.sku) : [])
    ));
    const componentDimsBySku = new Map<string, { weight_grams: number | null; length_mm: number | null; width_mm: number | null; height_mm: number | null }>();
    if (kitComponentSkus.length) {
      const componentResult = await query(
        `SELECT variant_sku,
                COALESCE(variant_weight_grams, weight_grams) AS weight_grams,
                COALESCE(variant_depth_mm, depth_mm) AS depth_mm,
                COALESCE(variant_width_mm, width_mm) AS width_mm,
                COALESCE(variant_height_mm, height_mm) AS height_mm
         FROM wms_products
         WHERE variant_sku = ANY($1::text[])`,
        [kitComponentSkus]
      );
      for (const row of componentResult.rows as any[]) {
        componentDimsBySku.set(row.variant_sku, {
          weight_grams: asNumber(row.weight_grams),
          length_mm: asNumber(row.depth_mm),
          width_mm: asNumber(row.width_mm),
          height_mm: asNumber(row.height_mm),
        });
      }
    }

    let services: ShippingService[] = [];
    let packagingProfiles: PackagingProfile[] = [];
    const fulfilmentBySku = new Map<string, FulfillmentProfileRow>();
    let dataSource: 'database' | 'fallback' = 'database';
    let aitServiceCode = 'ait_freight';
    let aitServiceName = 'AIT Freight (Oversized / Non-Parcel)';
    let aitPercentageOfPrice = 10;

    try {
      const aitResult = await query(
        `SELECT service_code, service_name, metadata FROM shipping_services WHERE service_code = 'ait_freight' AND is_active = true LIMIT 1`
      );
      if (aitResult.rows[0]) {
        aitServiceCode = aitResult.rows[0].service_code;
        aitServiceName = aitResult.rows[0].service_name;
        aitPercentageOfPrice = asNumber(aitResult.rows[0].metadata?.percentage_of_price) ?? 10;
      }
    } catch (err) {
      if (!isMissingRelationError(err)) throw err;
    }

    try {
      const [servicesResult, profilesResult, fulfilmentResult] = await Promise.all([
        query(
          `SELECT service_code, service_name, courier_code, courier_name, service_level, shipment_mode, constraints, metadata
           FROM shipping_services
           WHERE is_active = true
             AND courier_code = 'ups'
           ORDER BY sort_order ASC, service_name ASC`
        ),
        query(
          `SELECT code, name, package_type, inner_length_mm, inner_width_mm, inner_height_mm,
                  max_weight_grams, tare_weight_grams, default_cost_gbp
           FROM packaging_profiles
           WHERE is_active = true
             AND package_type IN ('parcel', 'freight')
           ORDER BY name ASC`
        ),
        skuList.length
          ? query(
              `SELECT product_sku, packaging_profile_code, preferred_service_code,
                      requires_manual_review, is_fragile, is_multi_box
               FROM product_fulfillment_profiles
               WHERE product_sku = ANY($1::text[])`,
              [skuList]
            )
          : Promise.resolve({ rows: [] as FulfillmentProfileRow[] }),
      ]);

      services = servicesResult.rows.map((row: any) => withServiceConstraintDefaults({
        service_code: row.service_code,
        service_name: row.service_name,
        courier_code: row.courier_code,
        courier_name: row.courier_name,
        service_level: row.service_level,
        shipment_mode: row.shipment_mode,
        constraints: row.constraints ?? {},
        metadata: row.metadata ?? {},
      }));

      packagingProfiles = profilesResult.rows.map((row: any) => ({
        code: row.code,
        name: row.name,
        package_type: row.package_type,
        inner_length_mm: row.inner_length_mm,
        inner_width_mm: row.inner_width_mm,
        inner_height_mm: row.inner_height_mm,
        max_weight_grams: row.max_weight_grams,
        tare_weight_grams: row.tare_weight_grams,
        default_cost_gbp: row.default_cost_gbp,
      }));

      for (const row of fulfilmentResult.rows as FulfillmentProfileRow[]) fulfilmentBySku.set(row.product_sku, row);
    } catch (err) {
      if (!isMissingRelationError(err)) throw err;
      dataSource = 'fallback';
      services = DEFAULT_SHIPPING_SERVICES
        .filter(s => s.courier_code === 'ups')
        .map(withServiceConstraintDefaults);
      packagingProfiles = DEFAULT_PACKAGING_PROFILES.filter(p => p.package_type === 'parcel' || p.package_type === 'freight');
    }

    const variants = await Promise.all(variantRows.map(async (row: any) => {
      const profile = fulfilmentBySku.get(row.variant_sku);
      let dims = {
        weight_grams: asNumber(row.weight_grams),
        length_mm: asNumber(row.depth_mm),
        width_mm: asNumber(row.width_mm),
        height_mm: asNumber(row.height_mm),
      };

      const hasOwnDims = Boolean(dims.weight_grams && dims.length_mm && dims.width_mm && dims.height_mm);
      if (!hasOwnDims && row.is_kit) {
        const kitComponents = JSON.parse(row.kit_components) as { sku: string; required_quantity: number }[];
        const kitDims = resolveKitDimensions(kitComponents, componentDimsBySku);
        if (kitDims.complete) dims = kitDims;
      }

      const estimate = estimateShippingForServices({
        dims,
        services,
        packagingProfiles,
        preferredPackagingCode: profile?.packaging_profile_code ?? null,
        packagingPaddingMinMm: 140,
        packagingPaddingMaxMm: 140,
      });

      const upsServices = estimate.estimates.filter(s => s.is_ups);
      const isUpsEligible = upsServices.some(s => s.eligible);
      const upsIneligibleReasons = upsServices.filter(s => !s.eligible).flatMap(s => s.reasons_not_eligible);

      const packed = estimate.packaged_dimensions;
      const lengthMm = packed.used_length_mm ?? 0;
      const widthMm = packed.used_width_mm ?? 0;
      const heightMm = packed.used_height_mm ?? 0;
      const hasCompletePackedDims = lengthMm > 0 && widthMm > 0 && heightMm > 0 && estimate.package_weight_grams > 0;
      const isFreightPackaging = estimate.picked_packaging_profile?.package_type === 'freight';

      let liveQuotes: UpsRateQuote[] | null = null;
      let liveQuoteError: string | null = null;
      let liveQuoteConfigRequired = false;
      let aitQuote: { service_code: string; service_name: string; percentage_of_price: number; price_gbp: number | null; estimated_cost_gbp: number | null } | null = null;

      if (isFreightPackaging) {
        // Doesn't fit a standard Bisley carton — Bisley ships these via AIT today, not UPS parcel,
        // so skip the live UPS Rating API call entirely and use a flat percentage-of-price quote.
        const priceGbp = asNumber(row.price_gbp);
        aitQuote = {
          service_code: aitServiceCode,
          service_name: aitServiceName,
          percentage_of_price: aitPercentageOfPrice,
          price_gbp: priceGbp,
          estimated_cost_gbp: priceGbp != null ? Math.round(priceGbp * (aitPercentageOfPrice / 100) * 100) / 100 : null,
        };
      } else if (!upsReferenceDestinationConfigured()) {
        liveQuoteConfigRequired = true;
        liveQuoteError = 'Live UPS rates are not configured. Set UPS_REFERENCE_DESTINATION_* env vars on the backend.';
      } else if (!hasCompletePackedDims) {
        liveQuoteError = 'Missing weight or dimensions — cannot request a live UPS rate.';
      } else {
        const result = await getCachedUpsRates({ lengthMm, widthMm, heightMm, weightGrams: estimate.package_weight_grams });
        // UPS's Rating API often omits Service.Description for this account — fall back to our own
        // configured service name (same catalogue shown in Settings > Shipping & Packing) for the same code.
        liveQuotes = result.quotes?.map((quote) => {
          const matchedService = quote.internalServiceCode
            ? services.find(s => s.service_code === quote.internalServiceCode)
            : null;
          return {
            ...quote,
            serviceName: matchedService?.service_name ?? quote.serviceName ?? `UPS service ${quote.upsServiceCode}`,
          };
        }) ?? null;
        liveQuoteError = result.error;
      }

      return {
        variant_id: row.medusa_variant_id,
        sku: row.variant_sku,
        variant_title: row.variant_title,
        colour_name: row.colour_name,
        raw_dimensions_mm: {
          length: dims.length_mm,
          width: dims.width_mm,
          height: dims.height_mm,
        },
        packaged_dimensions_mm: estimate.packaged_dimensions,
        product_weight_grams: dims.weight_grams,
        package_weight_grams: estimate.package_weight_grams,
        estimated_volume_litres: estimate.volume_litres,
        packaging_profile_code: estimate.picked_packaging_profile?.code ?? null,
        packaging_profile_name: estimate.picked_packaging_profile?.name ?? null,
        fulfillment_profile: {
          preferred_service_code: profile?.preferred_service_code ?? null,
          requires_manual_review: profile?.requires_manual_review ?? false,
          is_fragile: profile?.is_fragile ?? false,
          is_multi_box: profile?.is_multi_box ?? false,
        },
        ups_eligibility: {
          eligible: isUpsEligible,
          reasons_not_eligible: Array.from(new Set(upsIneligibleReasons)),
        },
        ups_live_quotes: liveQuotes,
        ups_live_quote_error: liveQuoteError,
        ups_live_quote_configuration_required: liveQuoteConfigRequired,
        ait_quote: aitQuote,
      };
    }));

    res.json({
      product: {
        id: product.id,
        handle: product.handle,
        title: product.title,
      },
      assumptions: {
        data_source: dataSource,
        packaging_dimension_allowance_mm: {
          min: 140,
          max: 140,
          used_for_estimation: 140,
        },
        live_rates: {
          source: 'ups_rating_api',
          environment: process.env.UPS_ENVIRONMENT ?? 'test',
          reference_destination: upsReferenceDestinationConfigured()
            ? {
                city: process.env.UPS_REFERENCE_DESTINATION_CITY,
                postal_code: process.env.UPS_REFERENCE_DESTINATION_POSTAL_CODE,
                country_code: process.env.UPS_REFERENCE_DESTINATION_COUNTRY_CODE,
              }
            : null,
          retrieved_at: new Date().toISOString(),
        },
        notes: [
          'ups_live_quotes is a real-time quote from the UPS Rating API, priced to the single reference destination above — not a per-customer price.',
          'ups_eligibility is a physical fit/weight pre-check against published UPS parcel/freight limits; the live quote response is the final word on availability.',
        ],
      },
      variants,
    });
  } catch (err) {
    console.error('Shipping estimate error:', err);
    res.status(500).json({ error: 'Failed to compute shipping estimates', detail: (err as Error).message });
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
