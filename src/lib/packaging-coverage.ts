/**
 * Packaging coverage: which products each box, sleeve, tray and edge guard covers, and which packs each product uses.
 * Built from the WMS packaging BOMs. A product's first choice is its rank 1 option, the rest are alternatives.
 * Read only.
 */
import { query } from '../db/index.js';
import { slashShelfCount } from './pick-list-packaging.js';
import { sizeText } from './packaging-plan.js';

export interface CoverageBomRow {
  product_code: string | null;
  sku: string | null;
  option_rank: number | null;
  method: string | null;
  /** Null when the BOM has no lines. */
  code: string | null;
  item_type: string | null;
}

export interface CoveragePackRow {
  code: string;
  item_type: string;
  stock_on_hand: number | null;
  unit_cost: number | null;
  size: string | null;
  merge_into: string | null;
}

export interface CoverageSpecRow { product_code: string; product_title: string | null; method: string | null }

export interface ProductCoverage {
  product: string;
  title: string;
  /** Method on the product record: box, sleeve_tray, own_box and so on. */
  method: string;
  first_choice: string[];
  alternatives: string[][];
  open_orders: number;
}

export interface PackCoverage {
  code: string;
  type: string;
  size: string | null;
  unit_cost: number | null;
  on_hand: number | null;
  merge_into: string | null;
  first_choice: string[];
  alternative_only: string[];
  open_orders: number;
}

const PACK_TYPES = new Set(['box', 'tray', 'sleeve', 'edge_guard']);
const TYPE_ORDER: Record<string, number> = { box: 0, sleeve: 1, tray: 2, edge_guard: 3 };

/** A sold SKU belongs to a product code in either spelling (YECB0819-4S-bn6 and YECB0819/4S). */
export function skuBelongsTo(sku: string, code: string): boolean {
  const upper = sku.toUpperCase();
  const slashed = slashShelfCount(upper);
  const key = code.toUpperCase();
  return upper === key || upper.startsWith(`${key}-`) || slashed === key || slashed.startsWith(`${key}-`);
}

export function buildCoverage(input: {
  boms: CoverageBomRow[];
  packs: CoveragePackRow[];
  specs: CoverageSpecRow[];
  /** One entry per open order line: the sold SKU and its order id. */
  openLines: { sku: string; orderId: string }[];
}): { products: ProductCoverage[]; packs: PackCoverage[] } {
  const packBy = new Map(input.packs.map((pack) => [pack.code, pack]));
  const specBy = new Map(input.specs.map((spec) => [spec.product_code.toUpperCase(), spec]));

  // product key -> rank -> pack codes
  const options = new Map<string, Map<number, Set<string>>>();
  const methodOf = new Map<string, string>();
  for (const row of input.boms) {
    const key = (row.sku || row.product_code || '').trim();
    if (!key) continue;
    const rank = Number(row.option_rank) || 1;
    if (!options.has(key)) options.set(key, new Map());
    const byRank = options.get(key)!;
    if (!byRank.has(rank)) byRank.set(rank, new Set());
    if (row.method && rank === 1) methodOf.set(key, row.method);
    if (row.code && row.item_type && PACK_TYPES.has(row.item_type)) byRank.get(rank)!.add(row.code);
  }
  for (const spec of input.specs) {
    const key = spec.product_code;
    if (!options.has(key) && !options.has(key.toUpperCase())) options.set(key, new Map());
    if (!methodOf.has(key) && spec.method) methodOf.set(key, spec.method);
  }

  const orderSets = new Map<string, Set<string>>();
  const codes = [...options.keys()];
  for (const line of input.openLines) {
    for (const code of codes) {
      if (skuBelongsTo(line.sku, code)) {
        if (!orderSets.has(code)) orderSets.set(code, new Set());
        orderSets.get(code)!.add(line.orderId);
      }
    }
  }

  const sortCodes = (list: Iterable<string>) => [...list].sort((a, b) => {
    const pa = packBy.get(a), pb = packBy.get(b);
    return (TYPE_ORDER[pa?.item_type || ''] ?? 9) - (TYPE_ORDER[pb?.item_type || ''] ?? 9) || a.localeCompare(b, undefined, { numeric: true });
  });

  const products: ProductCoverage[] = [];
  const packFirst = new Map<string, Set<string>>();
  const packAlt = new Map<string, Set<string>>();
  for (const [key, byRank] of options) {
    const ranks = [...byRank.keys()].sort((a, b) => a - b);
    const first = ranks.length ? sortCodes(byRank.get(ranks[0])!) : [];
    const alternatives = ranks.slice(1).map((rank) => sortCodes(byRank.get(rank)!)).filter((list) => list.length);
    for (const code of first) { if (!packFirst.has(code)) packFirst.set(code, new Set()); packFirst.get(code)!.add(key); }
    for (const list of alternatives) for (const code of list) { if (!packAlt.has(code)) packAlt.set(code, new Set()); packAlt.get(code)!.add(key); }
    const spec = specBy.get(key.toUpperCase());
    products.push({
      product: key,
      title: spec?.product_title || '',
      method: methodOf.get(key) || spec?.method || '',
      first_choice: first,
      alternatives,
      open_orders: orderSets.get(key)?.size || 0,
    });
  }
  products.sort((a, b) => a.product.localeCompare(b.product, undefined, { numeric: true }));
  const openBy = new Map(products.map((product) => [product.product, product.open_orders]));

  const packs: PackCoverage[] = [];
  for (const code of new Set([...packFirst.keys(), ...packAlt.keys()])) {
    const pack = packBy.get(code);
    const first = [...(packFirst.get(code) || [])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const altOnly = [...(packAlt.get(code) || [])].filter((p) => !packFirst.get(code)?.has(p)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    packs.push({
      code,
      type: pack?.item_type || '',
      size: pack?.size ?? null,
      unit_cost: pack?.unit_cost ?? null,
      on_hand: pack?.stock_on_hand ?? null,
      merge_into: pack?.merge_into ?? null,
      first_choice: first,
      alternative_only: altOnly,
      open_orders: [...first, ...altOnly].reduce((sum, product) => sum + (openBy.get(product) || 0), 0),
    });
  }
  packs.sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || a.code.localeCompare(b.code, undefined, { numeric: true }));
  return { products, packs };
}

export async function loadCoverage() {
  const boms = (await query(
    `SELECT b.product_code, b.sku, b.option_rank, b.method, i.code, i.item_type
       FROM packaging_boms b
       LEFT JOIN packaging_bom_lines l ON l.bom_id = b.id
       LEFT JOIN packaging_items i ON i.id = l.packaging_item_id AND i.is_active
      WHERE b.is_active`,
  )).rows as CoverageBomRow[];
  const packRows = (await query(
    `SELECT code, item_type, stock_on_hand, unit_cost_gbp, internal_length_mm, internal_width_mm, internal_height_mm,
            extra->>'box_size_formula' AS box_size_formula, extra->>'merge_into' AS merge_into
       FROM packaging_items WHERE is_active`,
  )).rows;
  const packs: CoveragePackRow[] = packRows.map((row: any) => ({
    code: String(row.code),
    item_type: String(row.item_type),
    stock_on_hand: row.stock_on_hand == null ? null : Number(row.stock_on_hand),
    unit_cost: row.unit_cost_gbp == null ? null : Number(row.unit_cost_gbp),
    size: row.item_type === 'box' ? sizeText(row) : null,
    merge_into: row.merge_into || null,
  }));
  const specs = (await query(`SELECT product_code, product_title, method FROM packaging_product_specs WHERE is_active`)).rows as CoverageSpecRow[];
  const openLines = (await query(
    `SELECT pli.product_sku AS sku, pl.id AS "orderId"
       FROM pick_list_items pli JOIN pick_lists pl ON pl.id = pli.pick_list_id
      WHERE NOT COALESCE(pl.is_archived, false) AND NOT COALESCE(pl.is_sandbox, false)
        AND pl.status IN ('PENDING', 'AWAITING_STOCK')
        AND NOT COALESCE(pli.is_archived, false) AND COALESCE(pli.product_sku, '') <> ''`,
  )).rows as { sku: string; orderId: string }[];
  return { generated_at: new Date().toISOString(), ...buildCoverage({ boms, packs, specs, openLines }) };
}
