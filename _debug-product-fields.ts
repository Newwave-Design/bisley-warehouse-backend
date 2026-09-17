import { getMedusaToken } from './src/lib/medusa-client';

const MEDUSA_URL = 'https://bisley-shop.medusajs.app';

const token = await getMedusaToken();
const auth = { Authorization: `Bearer ${token}` };

console.log('Fetching first 3 published products with full detail…\n');

const d = await fetch(
  `${MEDUSA_URL}/admin/products?limit=3&offset=0&status[]=published` +
  `&fields=id,title,handle,weight,height,width,length,*variants`,
  { headers: auth }
).then(r => r.json());

console.log('API Response structure:');
console.log(JSON.stringify(d.products?.[0], null, 2).substring(0, 2000));

console.log('\n\n=== VARIANT STRUCTURE ===');
if (d.products?.[0]?.variants?.[0]) {
  console.log(JSON.stringify(d.products[0].variants[0], null, 2).substring(0, 1500));
}

console.log('\n\n=== CHECKING ALL VARIANTS FOR DIMENSION FIELDS ===');
let withDims = 0, withoutDims = 0;
for (const p of d.products ?? []) {
  for (const v of p.variants ?? []) {
    const hasDims = v.weight != null && v.height != null && v.width != null && v.length != null;
    if (hasDims) withDims++;
    else withoutDims++;
    
    console.log(`${v.sku}: weight=${v.weight}, height=${v.height}, width=${v.width}, length=${v.length} → ${hasDims ? '✓' : '✗'}`);
  }
}
console.log(`\nResults: ${withDims} with dims, ${withoutDims} without`);
