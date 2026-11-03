import { readFileSync } from 'fs';
import { query } from '../db/index.js';

/** SmartSuite "Link to Shipping" title for each listed product code. */
const SHIPPING_OPTION: Record<string, string> = JSON.parse(
  readFileSync(new URL('../data/shipping-options.json', import.meta.url), 'utf8')
);

/** MultiDesk desks, tops and legs go DX. */
function isMultiDesk(sku: string): boolean {
  return /^MD(?:M|P|HLEG|WLEG|TM|TP)/.test(sku.toUpperCase());
}

export function shippingOption(sku: string, productCode = ''): string | null {
  const upper = sku.toUpperCase();
  if (isMultiDesk(upper) || isMultiDesk(productCode)) return 'DX';
  const normalised = upper.replace(/-(\dS)(?=-|$)/, '/$1');
  if (SHIPPING_OPTION[normalised]) return SHIPPING_OPTION[normalised];
  if (productCode && SHIPPING_OPTION[productCode]) return SHIPPING_OPTION[productCode];
  const code = Object.keys(SHIPPING_OPTION).sort((a, b) => b.length - a.length)
    .find((entry) => normalised === entry || normalised.startsWith(`${entry}-`));
  return code ? SHIPPING_OPTION[code] : null;
}

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

type PackagingLine = {
  code: string
  name: string
  item_type: string
  qty: number
  box: { code: string; length: number; width: number; height: number } | null
};

/** Outer size written on the box as "740L 1,185W 155H, 1,925L&W". The girth after the comma is not a side. */
function parseBoxSize(formula: string | null | undefined): { length: number; width: number; height: number } | null {
  const head = String(formula || '').split(/,(?=\s*\d[\d,]*\s*L&W)/i)[0];
  const length = head.match(/(\d[\d,]*(?:\.\d+)?)\s*L/i);
  const width = head.match(/(\d[\d,]*(?:\.\d+)?)\s*W/i);
  const height = head.match(/(\d[\d,]*(?:\.\d+)?)\s*H/i);
  if (!length || !width || !height) return null;
  const sides = [length, width, height].map((side) => Math.round(Number(side[1].replace(/,/g, ''))));
  if (sides.some((side) => !Number.isFinite(side) || side <= 0)) return null;
  return { length: sides[0], width: sides[1], height: sides[2] };
}

/**
 * Packaging already kept under Stock → Packaging.
 * A catalogue code matches a variant when the SKU is that code, or that code plus a colour suffix.
 * The longest matching code wins (1633 before 163).
 */
export async function attachPackaging<T extends { sku: string; quantity_required: number }>(groups: T[][]): Promise<T[][]> {
  const skus = [...new Set(groups.flat().map(i => i.sku).filter(Boolean))];
  if (!skus.length) return groups;

  const [specs, boms] = await Promise.all([
    query(`SELECT product_code, method, preferred_courier, weight_grams,
                  length_packed_mm, width_packed_mm, height_packed_mm
           FROM packaging_product_specs WHERE is_active`),
    query(
      `SELECT b.product_code, b.sku, b.method, b.option_rank,
              i.code, i.name, i.item_type, l.qty,
              i.internal_length_mm, i.internal_width_mm, i.internal_height_mm,
              i.extra->>'box_size_formula' AS box_size_formula
       FROM packaging_boms b
       LEFT JOIN packaging_bom_lines l ON l.bom_id = b.id
       LEFT JOIN packaging_items i ON i.id = l.packaging_item_id
       WHERE b.is_active
       ORDER BY b.option_rank, i.item_type, i.code`
    ),
  ]);

  const specByCode = new Map<string, {
    method: string
    courier: string | null
    weight: number | null
    length: number | null
    width: number | null
    height: number | null
  }>();
  const codes: string[] = [];
  for (const row of specs.rows as { product_code: string; method: string; preferred_courier: string | null; weight_grams: number | null; length_packed_mm: number | null; width_packed_mm: number | null; height_packed_mm: number | null }[]) {
    const code = String(row.product_code || '').toUpperCase();
    if (!code || specByCode.has(code)) continue;
    const rawCourier = String(row.preferred_courier || '').trim();
    const courier = /^dx$/i.test(rawCourier) ? 'DX' : /apc/i.test(rawCourier) ? 'APC' : (rawCourier || null);
    specByCode.set(code, {
      method: row.method,
      courier,
      weight: row.weight_grams,
      length: row.length_packed_mm,
      width: row.width_packed_mm,
      height: row.height_packed_mm,
    });
    codes.push(code);
  }
  codes.sort((a, b) => b.length - a.length);

  const bomBySku = new Map<string, { method: string; rank: number; lines: PackagingLine[] }>();
  const bomByProduct = new Map<string, { method: string; rank: number; lines: PackagingLine[] }>();
  for (const row of boms.rows as {
    product_code: string | null
    sku: string | null
    method: string
    option_rank: number
    code: string | null
    name: string | null
    item_type: string | null
    qty: string | null
    internal_length_mm: number | null
    internal_width_mm: number | null
    internal_height_mm: number | null
    box_size_formula: string | null
  }[]) {
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
      const drawn = [row.internal_length_mm, row.internal_width_mm, row.internal_height_mm].map((side) => Number(side) || 0);
      const outer = row.item_type === 'box'
        ? (parseBoxSize(row.box_size_formula) || (drawn.every((side) => side > 0) ? { length: drawn[0], width: drawn[1], height: drawn[2] } : null))
        : null;
      entry.lines.push({
        code: row.code,
        name: row.name || row.code,
        item_type: row.item_type || 'other',
        qty: Number(row.qty) || 1,
        box: outer ? { code: row.code, ...outer } : null,
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
    const productCode = codes.find(entry => exact === entry || exact.startsWith(`${entry}-`)) || '';
    const spec = productCode ? specByCode.get(productCode) : specByCode.get(exact);
    const method = chosen?.method || spec?.method || '';
    const option = shippingOption(item.sku, productCode || exact);
    if (!method && !chosen && !spec?.courier && !option) return item;
    const per = item.quantity_required > 0 ? item.quantity_required : 1;
    const lines = (chosen?.lines || []).map(line => ({
      code: line.code,
      name: line.name,
      item_type: line.item_type,
      item_label: PACKAGING_ITEM_LABEL[line.item_type] || line.item_type,
      qty: Math.round(line.qty * per * 100) / 100,
    }));
    const box = (chosen?.lines || []).find(line => line.box)?.box || null;
    return {
      ...item,
      packaging: {
        product_code: code || exact,
        method,
        type: PACKAGING_SHIP_TYPE[method] || null,
        note: lines.length ? null : (PACKAGING_METHOD_NOTE[method] || null),
        items: lines,
        preferred_courier: isMultiDesk(exact) || isMultiDesk(productCode) ? 'DX' : (spec?.courier || null),
        shipping_option: option,
        weight_grams: spec?.weight ?? null,
        length_packed_mm: spec?.length ?? null,
        width_packed_mm: spec?.width ?? null,
        height_packed_mm: spec?.height ?? null,
        box_code: box?.code || null,
        box_length_mm: box?.length ?? null,
        box_width_mm: box?.width ?? null,
        box_height_mm: box?.height ?? null,
      },
    };
  }));
}
