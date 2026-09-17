import { getMedusaToken, MEDUSA_URL } from './src/lib/medusa-client.js';

const token = await getMedusaToken();
const auth = { Authorization: `Bearer ${token}` };

console.log('Fetching all published products from Medusa…\n');
const allMedusaProducts = [];
let pOff = 0;
while (true) {
  const d = await fetch(
    `${MEDUSA_URL}/admin/products?limit=100&offset=${pOff}&status[]=published` +
    `&fields=id,title,handle,*variants`,
    { headers: auth }
  ).then(r => r.json());

  for (const p of d.products ?? []) {
    allMedusaProducts.push({
      id: p.id,
      title: p.title,
      handle: p.handle,
      variant_count: (p.variants ?? []).length,
      variants: (p.variants ?? []).map(v => ({ sku: v.sku, title: v.title })),
    });
  }
  pOff += 100;
  if (pOff >= (d.count ?? 0)) break;
}

console.log(`Total published products in Medusa: ${allMedusaProducts.length}`);
console.log(`Total published variants in Medusa: ${allMedusaProducts.reduce((s, p) => s + p.variant_count, 0)}\n`);

// Now fetch with full dimensions
console.log('Fetching products with full dimension detail…\n');
const productsWithDims = [];
pOff = 0;
while (true) {
  const d = await fetch(
    `${MEDUSA_URL}/admin/products?limit=100&offset=${pOff}&status[]=published` +
    `&fields=id,title,handle,weight,height,width,length,*variants,*variants.prices`,
    { headers: auth }
  ).then(r => r.json());

  for (const p of d.products ?? []) {
    const variantsWithDims = (p.variants ?? []).filter(v => 
      v.weight != null && v.height != null && v.width != null && v.length != null
    );
    const variantsNoDims = (p.variants ?? []).filter(v => 
      v.weight == null || v.height == null || v.width == null || v.length == null
    );
    if (variantsWithDims.length > 0) {
      productsWithDims.push({
        product: p.title,
        with_dims: variantsWithDims.length,
        without_dims: variantsNoDims.length,
      });
    }
    if (variantsNoDims.length > 0) {
      console.log(`⚠ ${p.title}`);
      console.log(`  Variants WITH dimensions: ${variantsWithDims.length}`);
      console.log(`  Variants WITHOUT dimensions: ${variantsNoDims.length}`);
      for (const v of variantsNoDims.slice(0, 3)) {
        console.log(`    - ${v.sku ?? 'no-sku'}: weight=${v.weight}, h=${v.height}, w=${v.width}, d=${v.length}`);
      }
    }
  }
  pOff += 100;
  if (pOff >= (d.count ?? 0)) break;
}

const totalWithDims = productsWithDims.reduce((s, p) => s + p.with_dims, 0);
console.log(`\n✓ Products with at least 1 variant having full dimensions: ${productsWithDims.length}`);
console.log(`✓ Total variants with full dimensions: ${totalWithDims}`);
console.log(`\nExpected sync result: ~${totalWithDims} inserts/updates`);
console.log('If you see "814 updated" with "0 inserted", those 814 were already in wms_products from a previous sync.\n');
