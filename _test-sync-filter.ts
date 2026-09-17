import { getMedusaToken } from './src/lib/medusa-client';

const MEDUSA_URL = 'https://bisley-shop.medusajs.app';
const LOCATION_ID = 'sloc_01KY792H831KT3TKH4CYPF7FT9';

async function testSync() {
  const token = await getMedusaToken();
  const auth = { Authorization: `Bearer ${token}` };

  // Simplified version of fetchAllProductsFromMedusa
  const products = [];
  let pOff = 0;
  
  while (true) {
    const d = await fetch(
      `${MEDUSA_URL}/admin/products?limit=100&offset=${pOff}&status[]=published` +
      `&fields=id,title,subtitle,description,handle,status,thumbnail,material,weight,height,width,length,metadata` +
      `,*images,*variants,*variants.inventory_items,*variants.inventory_items.inventory_item,*variants.prices`,
      { headers: auth }
    ).then(r => r.json());

    for (const p of d.products ?? []) {
      const variants = (p.variants ?? [])
        .map((v) => {
          const weight_grams = v.weight ?? p.weight ?? null;
          const height_mm = v.height ?? p.height ?? null;
          const width_mm = v.width ?? p.width ?? null;
          const depth_mm = v.length ?? p.length ?? null;

          return { sku: v.sku, weight_grams, height_mm, width_mm, depth_mm };
        })
        .filter((v) => {
          const passes = v.weight_grams != null && v.height_mm != null && v.width_mm != null && v.depth_mm != null;
          if (!passes && p.title === 'Fern Stendi') {
            console.log(`[FILTER-REJECT] ${v.sku}: w=${v.weight_grams}, h=${v.height_mm}, w=${v.width_mm}, d=${v.depth_mm}`);
          }
          return passes;
        });

      if (variants.length > 0) {
        products.push({ title: p.title, variantCount: variants.length });
        if (p.title === 'Fern Stendi') {
          console.log(`✓ Fern Stendi: PASSED ${variants.length} variants`);
        }
      } else if (p.title === 'Fern Stendi') {
        console.log(`✗ Fern Stendi: FILTERED OUT all variants (total variants in product: ${(p.variants ?? []).length})`);
        console.log(`  Product dims: w=${p.weight}, h=${p.height}, w=${p.width}, d=${p.length}`);
      }
    }

    pOff += 100;
    if (pOff >= (d.count ?? 0)) break;
  }

  console.log(`\n✓ Total products with qualifying variants: ${products.length}`);
  console.log(`✓ Total qualifying variants: ${products.reduce((s, p) => s + p.variantCount, 0)}`);
}

testSync().catch(err => console.error('Error:', err.message));
