import { query } from '../db/index.js';

/** Ship class the pick list shows. Packaging stores method, not the words parcel/box/pallet. */
const PACKAGING_SHIP_TYPE: Record<string, 'Parcel' | 'Box' | 'Pallet'> = {
  sleeve_tray: 'Parcel',
  pack_to_fit: 'Parcel',
  box: 'Box',
  own_box: 'Box',
  pallet_wrap: 'Pallet',
};

const PACKAGING_ITEM_LABEL: Record<string, string> = {
  box: 'Box',
  tray: 'Tray',
  sleeve: 'Sleeve',
  edge_guard: 'Edge guard',
  corner: 'Corner',
  foam: 'Foam',
  tape: 'Tape',
  wrap: 'Wrap',
  label: 'Label',
  other: 'Other',
};

const PACKAGING_METHOD_NOTE: Record<string, string> = {
  own_box: 'Own box',
  pack_to_fit: 'Pack to fit',
  pallet_wrap: 'Pallet wrap',
  needs_packaging: 'Not set',
};

type PackagingLine = { code: string; name: string; item_type: string; qty: number };

/**
 * Packaging already kept under Stock → Packaging.
 * A catalogue code matches a variant when the SKU is that code, or that code plus a colour suffix.
 * The longest matching code wins (1633 before 163).
 */
export async function attachPackaging<T extends { sku: string; quantity_required: number }>(groups: T[][]): Promise<T[][]> {
  const skus = [...new Set(groups.flat().map(i => i.sku).filter(Boolean))];
  if (!skus.length) return groups;

  const [specs, boms] = await Promise.all([
    query(`SELECT product_code, method FROM packaging_product_specs WHERE is_active`),
    query(
      `SELECT b.product_code, b.sku, b.method, b.option_rank,
              i.code, i.name, i.item_type, l.qty
       FROM packaging_boms b
       LEFT JOIN packaging_bom_lines l ON l.bom_id = b.id
       LEFT JOIN packaging_items i ON i.id = l.packaging_item_id
       WHERE b.is_active
       ORDER BY b.option_rank, i.item_type, i.code`
    ),
  ]);

  const specByCode = new Map<string, string>();
  const codes: string[] = [];
  for (const row of specs.rows as { product_code: string; method: string }[]) {
    const code = String(row.product_code || '').toUpperCase();
    if (!code || specByCode.has(code)) continue;
    specByCode.set(code, row.method);
    codes.push(code);
  }
  codes.sort((a, b) => b.length - a.length);

  const bomBySku = new Map<string, { method: string; rank: number; lines: PackagingLine[] }>();
  const bomByProduct = new Map<string, { method: string; rank: number; lines: PackagingLine[] }>();
  for (const row of boms.rows as { product_code: string | null; sku: string | null; method: string; option_rank: number; code: string | null; name: string | null; item_type: string | null; qty: string | null }[]) {
    const skuKey = row.sku ? String(row.sku).toUpperCase() : '';
    const productKey = row.product_code ? String(row.product_code).toUpperCase() : '';
    const map = skuKey ? bomBySku : bomByProduct;
    const key = skuKey || productKey;
    if (!key) continue;
    let entry = map.get(key);
    if (!entry) {
      entry = { method: row.method, rank: Number(row.option_rank) || 1, lines: [] };
      map.set(key, entry);
    }
    if ((Number(row.option_rank) || 1) !== entry.rank) continue;
    if (row.code) {
      entry.lines.push({
        code: row.code,
        name: row.name || row.code,
        item_type: row.item_type || 'other',
        qty: Number(row.qty) || 1,
      });
    }
  }

  const matchCode = (sku: string) => {
    const upper = sku.toUpperCase();
    if (specByCode.has(upper) || bomBySku.has(upper)) return upper;
    return codes.find(code => upper.startsWith(`${code}-`)) || '';
  };

  return groups.map(items => items.map(item => {
    if (!item.sku) return item;
    const exact = item.sku.toUpperCase();
    const bom = bomBySku.get(exact);
    const code = bom ? '' : matchCode(item.sku);
    const productBom = code ? bomByProduct.get(code) : undefined;
    const chosen = bom || productBom;
    const method = chosen?.method || (code ? specByCode.get(code) : specByCode.get(exact)) || '';
    if (!method && !chosen) return item;
    const per = item.quantity_required > 0 ? item.quantity_required : 1;
    const lines = (chosen?.lines || []).map(line => ({
      code: line.code,
      name: line.name,
      item_type: line.item_type,
      item_label: PACKAGING_ITEM_LABEL[line.item_type] || line.item_type,
      qty: Math.round(line.qty * per * 100) / 100,
    }));
    return {
      ...item,
      packaging: {
        product_code: code || exact,
        method,
        type: PACKAGING_SHIP_TYPE[method] || null,
        note: lines.length ? null : (PACKAGING_METHOD_NOTE[method] || null),
        items: lines,
      },
    };
  }));
}
