/**
 * Products API Route
 * Fetches all Medusa products with variants and inventory kit info.
 * Results cached for 5 minutes — bust with ?refresh=true.
 */

import express, { Response } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { getMedusaToken, MEDUSA_URL } from '../../lib/medusa-client.js';

const router = express.Router();

interface KitComponent { sku: string; required_quantity: number }

interface WmsVariant {
  id: string;
  sku: string;
  title: string;
  thumbnail: string | null;
  manage_inventory: boolean;
  is_kit: boolean;
  kit_components: KitComponent[];
  inventory_qty: number;
}

interface WmsProduct {
  id: string;
  title: string;
  handle: string;
  status: string;
  thumbnail: string | null;
  variant_count: number;
  kit_variant_count: number;
  variants: WmsVariant[];
}

let _cache: WmsProduct[] | null = null;
let _cacheExpiry = 0;

async function fetchAllProducts(forceRefresh = false): Promise<WmsProduct[]> {
  if (!forceRefresh && _cache && Date.now() < _cacheExpiry) return _cache;

  const token = await getMedusaToken();
  const auth = { Authorization: `Bearer ${token}` };

  // Step 1: Fetch all inventory items with location levels (for stock levels)
  const inventoryMap = new Map<string, number>(); // sku → available_qty
  let invOffset = 0;
  while (true) {
    const d = await fetch(
      `${MEDUSA_URL}/admin/inventory-items?limit=100&offset=${invOffset}&fields=id,sku,location_levels.available_quantity`,
      { headers: auth }
    ).then(r => r.json()) as any;
    for (const item of d.inventory_items ?? []) {
      const qty = (item.location_levels ?? []).reduce((s: number, l: any) => s + (l.available_quantity ?? 0), 0);
      if (item.sku) inventoryMap.set(item.sku, qty);
    }
    invOffset += 100;
    if (invOffset >= (d.count ?? 0)) break;
  }

  // Step 2: Fetch all products with variants and their inventory_items links
  // +variants.inventory_items expands the variant→inventory_item link (includes required_quantity)
  const products: WmsProduct[] = [];
  let pOffset = 0;
  while (true) {
    const d = await fetch(
      `${MEDUSA_URL}/admin/products?limit=100&offset=${pOffset}` +
      `&fields=id,title,handle,status,thumbnail,*variants,*variants.inventory_items,*variants.inventory_items.inventory_item`,
      { headers: auth }
    ).then(r => r.json()) as any;

    for (const p of d.products ?? []) {
      const variants: WmsVariant[] = (p.variants ?? []).map((v: any) => {
        const links: any[] = v.inventory_items ?? [];
        const kit_components: KitComponent[] = links
          .map((link: any) => ({
            sku: link.inventory_item?.sku ?? link.inventory_item_id,
            required_quantity: link.required_quantity ?? 1,
          }))
          .filter(c => c.sku);
        const is_kit = links.length > 1;
        // Stock qty: sum across all linked inventory items
        const inventory_qty = kit_components.length > 0
          ? Math.min(...kit_components.map(c => Math.floor((inventoryMap.get(c.sku) ?? 0) / c.required_quantity)))
          : inventoryMap.get(v.sku) ?? 0;

        return {
          id: v.id,
          sku: v.sku ?? '',
          title: v.title ?? '',
          thumbnail: v.thumbnail ?? null,
          manage_inventory: !!v.manage_inventory,
          is_kit,
          kit_components,
          inventory_qty,
        };
      });

      products.push({
        id: p.id,
        title: p.title,
        handle: p.handle,
        status: p.status,
        thumbnail: p.thumbnail ?? null,
        variant_count: variants.length,
        kit_variant_count: variants.filter(v => v.is_kit).length,
        variants,
      });
    }

    pOffset += 100;
    if (pOffset >= (d.count ?? 0)) break;
  }

  _cache = products;
  _cacheExpiry = Date.now() + 5 * 60 * 1000; // 5 min TTL
  return products;
}

/**
 * GET /api/products
 * Returns all Medusa products with variant and kit info.
 * Query params: refresh=true, search=<string>, status=published|draft
 */
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const search = ((req.query.search as string) ?? '').toLowerCase();
    const statusFilter = (req.query.status as string) ?? '';

    const allProducts = await fetchAllProducts(forceRefresh);

    let filtered = allProducts;
    if (search) {
      filtered = filtered.filter(
        p => p.title.toLowerCase().includes(search) || p.handle.includes(search)
      );
    }
    if (statusFilter) {
      filtered = filtered.filter(p => p.status === statusFilter);
    }

    res.json({
      products: filtered,
      total: filtered.length,
      stats: {
        total_products: allProducts.length,
        total_variants: allProducts.reduce((s, p) => s + p.variant_count, 0),
        kit_variants: allProducts.reduce((s, p) => s + p.kit_variant_count, 0),
        published: allProducts.filter(p => p.status === 'published').length,
      },
      cached: !forceRefresh && _cache !== null,
    });
  } catch (err) {
    console.error('Products fetch error:', err);
    res.status(503).json({ error: 'Could not fetch products from Medusa', detail: (err as Error).message });
  }
});

/**
 * GET /api/products/:id
 * Returns a single product with full variant and kit detail.
 */
router.get('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const products = await fetchAllProducts();
    const product = products.find(p => p.id === req.params.id || p.handle === req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ product });
  } catch (err) {
    res.status(503).json({ error: 'Could not fetch product', detail: (err as Error).message });
  }
});

export default router;
