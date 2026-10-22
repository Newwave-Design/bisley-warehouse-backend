import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuid } from 'uuid';
import { query } from '../db/index.js';

type Counts = Record<string, { seen: number; upserted: number; skipped: number }>;

function loadTable(dir: string, name: string): { records: any[] } {
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) return { records: [] };
  return JSON.parse(readFileSync(file, 'utf8'));
}

function num(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function money(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[£,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function gramsFromWeight(v: any): number | null {
  const n = num(v);
  if (n == null) return null;
  return n < 500 ? Math.round(n * 1000) : Math.round(n);
}

/** SmartSuite singleselect stores option ids, not labels. */
const PACKAGING_TYPE_BY_ID: Record<string, { method: string; label: string; exclude?: boolean }> = {
  '13u9c': { method: 'box', label: 'Box' },
  YXTRA: { method: 'sleeve_tray', label: 'Sleeve' },
  wnqqo: { method: 'own_box', label: 'Own Box' },
  e1k73: { method: 'pallet_wrap', label: 'Pallete Wrap' },
  '3bfpz': { method: 'pack_to_fit', label: 'Packet' },
  '4WVhd': { method: 'pack_to_fit', label: 'Desk Top' },
  affxs: { method: 'needs_packaging', label: 'Exclude', exclude: true },
};

function mapPackagingType(raw: any): { method: string; label: string; exclude: boolean; raw: string } {
  const token = String(raw || '').trim();
  if (PACKAGING_TYPE_BY_ID[token]) {
    const mapped = PACKAGING_TYPE_BY_ID[token];
    return { ...mapped, exclude: !!mapped.exclude, raw: token };
  }
  const lower = token.toLowerCase();
  if (/exclude/.test(lower)) return { method: 'needs_packaging', label: token, exclude: true, raw: token };
  if (/sleeve/.test(lower)) return { method: 'sleeve_tray', label: token, exclude: false, raw: token };
  if (/own\s*box/.test(lower)) return { method: 'own_box', label: token, exclude: false, raw: token };
  if (/pallet/.test(lower)) return { method: 'pallet_wrap', label: token, exclude: false, raw: token };
  if (/^box$/.test(lower)) return { method: 'box', label: token, exclude: false, raw: token };
  if (/packet|desk/.test(lower)) return { method: 'pack_to_fit', label: token, exclude: false, raw: token };
  return { method: 'needs_packaging', label: token || 'Unknown', exclude: false, raw: token };
}

function parseDims(text: string | null | undefined): { l: number | null; w: number | null; h: number | null } {
  if (!text) return { l: null, w: null, h: null };
  const parts = String(text).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/g);
  if (!parts || parts.length < 2) return { l: null, w: null, h: null };
  return { l: Number(parts[0]), w: Number(parts[1]), h: parts[2] ? Number(parts[2]) : null };
}

async function upsertItem(row: {
  item_type: string;
  code: string;
  name?: string | null;
  internal_length_mm?: number | null;
  internal_width_mm?: number | null;
  internal_height_mm?: number | null;
  length_mm?: number | null;
  thickness_mm?: number | null;
  gap_mm?: number | null;
  tare_weight_grams?: number | null;
  unit_cost_gbp?: number | null;
  supplier_code?: string | null;
  stocked?: boolean;
  smartsuite_id: string;
  smartsuite_table: string;
  notes?: string | null;
  extra?: Record<string, unknown>;
}) {
  const existing = await query(`SELECT id FROM packaging_items WHERE smartsuite_id = $1 OR code = $2`, [row.smartsuite_id, row.code]);
  if (existing.rows[0]) {
    await query(
      `UPDATE packaging_items SET
         item_type = $2, name = $3, internal_length_mm = $4, internal_width_mm = $5, internal_height_mm = $6,
         length_mm = $7, thickness_mm = $8, gap_mm = $9, tare_weight_grams = $10, unit_cost_gbp = COALESCE($11, unit_cost_gbp),
         supplier_code = COALESCE($12, supplier_code), stocked = $13, notes = COALESCE($14, notes),
         extra = COALESCE(extra,'{}'::jsonb) || $15::jsonb, updated_at = NOW()
       WHERE id = $1`,
      [
        existing.rows[0].id, row.item_type, row.name || row.code, row.internal_length_mm ?? null,
        row.internal_width_mm ?? null, row.internal_height_mm ?? null, row.length_mm ?? null,
        row.thickness_mm ?? null, row.gap_mm ?? null, row.tare_weight_grams ?? null,
        row.unit_cost_gbp ?? null, row.supplier_code ?? null, !!row.stocked, row.notes ?? null,
        JSON.stringify(row.extra || {}),
      ]
    );
    return existing.rows[0].id as string;
  }
  const id = uuid();
  await query(
    `INSERT INTO packaging_items (
       id, item_type, code, name, internal_length_mm, internal_width_mm, internal_height_mm,
       length_mm, thickness_mm, gap_mm, tare_weight_grams, unit_cost_gbp, supplier_code,
       stocked, smartsuite_id, smartsuite_table, notes, extra
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      id, row.item_type, row.code, row.name || row.code, row.internal_length_mm ?? null,
      row.internal_width_mm ?? null, row.internal_height_mm ?? null, row.length_mm ?? null,
      row.thickness_mm ?? null, row.gap_mm ?? null, row.tare_weight_grams ?? null,
      row.unit_cost_gbp ?? null, row.supplier_code ?? null, !!row.stocked,
      row.smartsuite_id, row.smartsuite_table, row.notes ?? null, JSON.stringify(row.extra || {}),
    ]
  );
  return id;
}

async function link(from_kind: string, from_key: string, to_kind: string, to_key: string, role: string) {
  await query(
    `INSERT INTO packaging_links (id, from_kind, from_key, to_kind, to_key, role)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (from_kind, from_key, to_kind, to_key, role) DO NOTHING`,
    [uuid(), from_kind, from_key, to_kind, to_key, role]
  );
}

function defaultDir() {
  return process.env.PACKAGING_SNAPSHOT_DIR
    || join(process.cwd(), 'data', 'packaging-snapshot-2026-10-22');
}

export async function importPackagingSnapshot(opts: { dryRun?: boolean; sourceDir?: string } = {}) {
  const dir = opts.sourceDir || defaultDir();
  const dryRun = opts.dryRun !== false;
  const counts: Counts = {};
  const bump = (k: string, field: 'seen' | 'upserted' | 'skipped') => {
    counts[k] ||= { seen: 0, upserted: 0, skipped: 0 };
    counts[k][field]++;
  };

  const boxes = loadTable(dir, 'Boxes').records;
  const trays = loadTable(dir, 'Trays').records;
  const sleeves = loadTable(dir, 'Sleeves').records;
  const edges = loadTable(dir, 'Edge_Guard').records;
  const corners = loadTable(dir, 'Packaging_Items_Corners').records;
  const sets = loadTable(dir, 'Sleeve_Unique_Sizes').records;
  const products = loadTable(dir, 'Products').records;

  if (dryRun) {
    return {
      dryRun: true,
      sourceDir: dir,
      would_import: {
        boxes: boxes.length, trays: trays.length, sleeves: sleeves.length,
        edge_guards: edges.length, corners: corners.length, sleeve_sets: sets.length, products: products.length,
      },
    };
  }

  const itemBySs = new Map<string, { id: string; code: string }>();

  for (const r of boxes) {
    bump('boxes', 'seen');
    const dims = parseDims(r.s0e2a6acaa);
    const id = await upsertItem({
      item_type: 'box',
      code: r.title,
      name: r.title,
      internal_length_mm: dims.l,
      internal_width_mm: dims.w,
      internal_height_mm: dims.h,
      unit_cost_gbp: money(r.s50a02c27e),
      tare_weight_grams: gramsFromWeight(r.sjiihxvt),
      stocked: !!r.s1de07a5a1,
      smartsuite_id: r.id,
      smartsuite_table: 'Boxes',
      extra: {
        design_text: r.s0e2a6acaa,
        box_size_formula: r.sa9b7fe02d,
        packed_max: { l: num(r.sd185e7a13), w: num(r.s9pdssra), h: num(r.sw18wuus) },
        units_month: num(r.s210acc4ea),
      },
    });
    itemBySs.set(r.id, { id, code: r.title });
    bump('boxes', 'upserted');
  }

  for (const r of trays) {
    bump('trays', 'seen');
    const id = await upsertItem({
      item_type: 'tray',
      code: r.title,
      name: r.title,
      internal_length_mm: num(r.s2158cb292),
      internal_width_mm: num(r.sv1t2c3w),
      internal_height_mm: num(r.smr20gfl),
      unit_cost_gbp: money(r.s021f1d95a),
      stocked: true,
      smartsuite_id: r.id,
      smartsuite_table: 'Trays',
    });
    itemBySs.set(r.id, { id, code: r.title });
    bump('trays', 'upserted');
  }

  for (const r of sleeves) {
    bump('sleeves', 'seen');
    const id = await upsertItem({
      item_type: 'sleeve',
      code: r.title,
      name: r.title,
      internal_length_mm: num(r.s2158cb292),
      internal_width_mm: num(r.sv1t2c3w),
      internal_height_mm: num(r.smr20gfl),
      tare_weight_grams: gramsFromWeight(r.sc3yzxj6),
      unit_cost_gbp: money(r.s7661e4be4),
      stocked: true,
      smartsuite_id: r.id,
      smartsuite_table: 'Sleeves',
    });
    itemBySs.set(r.id, { id, code: r.title });
    bump('sleeves', 'upserted');
  }

  for (const r of edges) {
    bump('edge_guards', 'seen');
    const code = String(r.title || '').replace(/\s+/g, '');
    const id = await upsertItem({
      item_type: 'edge_guard',
      code,
      name: r.title,
      length_mm: num(r.s69aad0dbd),
      unit_cost_gbp: money(r.s19e837919),
      stocked: true,
      smartsuite_id: r.id,
      smartsuite_table: 'Edge_Guard',
    });
    itemBySs.set(r.id, { id, code });
    bump('edge_guards', 'upserted');
  }

  for (const r of corners) {
    bump('corners', 'seen');
    const type = /foam/i.test(r.title) ? 'foam' : /edge/i.test(r.title) ? 'edge_guard' : 'corner';
    const code = type === 'foam' ? 'FOAM-50' : (r.s602e9b1d8 || r.title);
    const id = await upsertItem({
      item_type: type,
      code,
      name: r.title,
      thickness_mm: num(r.s8acf902d0),
      gap_mm: num(r.s1786d59d3),
      length_mm: num(r.s1b4bfe878),
      unit_cost_gbp: money(r.s5dc6dfbcf),
      supplier_code: r.s602e9b1d8 || null,
      stocked: true,
      smartsuite_id: r.id,
      smartsuite_table: 'Packaging_Items',
    });
    itemBySs.set(r.id, { id, code });
    bump('corners', 'upserted');
  }

  for (const r of sets) {
    bump('sleeve_sets', 'seen');
    const dims = parseDims(r.title);
    const trayId = r.s239sv1s?.[0];
    const sleeveId = r.sdltj60e?.[0];
    const edgeId = r.s0dm08rw?.[0];
    const tray = trayId ? itemBySs.get(trayId) : null;
    const sleeve = sleeveId ? itemBySs.get(sleeveId) : null;
    const edge = edgeId ? itemBySs.get(edgeId) : null;
    const existing = await query(`SELECT id FROM packaging_sleeve_sets WHERE smartsuite_id = $1 OR label = $2`, [r.id, r.title]);
    if (existing.rows[0]) {
      await query(
        `UPDATE packaging_sleeve_sets SET packed_length_mm=$2, packed_width_mm=$3, packed_height_mm=$4,
           tray_item_id=$5, sleeve_item_id=$6, edge_guard_item_id=$7, stocked=$8, extra=$9, updated_at=NOW()
         WHERE id=$1`,
        [existing.rows[0].id, dims.l, dims.w, dims.h, tray?.id || null, sleeve?.id || null, edge?.id || null,
          !!r.s1de07a5a1, JSON.stringify({ text: r.s0e2a6acaa })]
      );
    } else {
      await query(
        `INSERT INTO packaging_sleeve_sets (id, label, packed_length_mm, packed_width_mm, packed_height_mm, tray_item_id, sleeve_item_id, edge_guard_item_id, stocked, smartsuite_id, extra)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [uuid(), r.title, dims.l, dims.w, dims.h, tray?.id || null, sleeve?.id || null, edge?.id || null,
          !!r.s1de07a5a1, r.id, JSON.stringify({ text: r.s0e2a6acaa })]
      );
    }
    if (tray) await link('sleeve_set', r.title, 'item', tray.code, 'uses_tray');
    if (sleeve) await link('sleeve_set', r.title, 'item', sleeve.code, 'uses_sleeve');
    if (edge) await link('sleeve_set', r.title, 'item', edge.code, 'uses_edge_guard');
    bump('sleeve_sets', 'upserted');
  }

  for (const r of products) {
    bump('products', 'seen');
    const range = r.se5a55f52f || '';
    const packType = mapPackagingType(r.sf51a2f3c1);
    if (/essential/i.test(range) || packType.exclude) {
      bump('products', 'skipped');
      continue;
    }
    const method = packType.method;

    const existing = await query(`SELECT id FROM packaging_product_specs WHERE smartsuite_id = $1 OR product_code = $2`, [r.id, r.title]);
    const spec = {
      product_code: r.title,
      product_title: Array.isArray(r.s48aeccb37) ? null : r.s48aeccb37 || r.title,
      product_range: range || null,
      length_mm: num(r.sbf5132fcc),
      width_mm: num(r.s5caaab512),
      height_mm: num(r.s509606f16),
      length_packed_mm: num(r.s3332a097a),
      width_packed_mm: num(r.s5c75d234d),
      height_packed_mm: num(r.sbd8239c4c),
      packed_dims_checked: !!r.sc5d97ca62,
      weight_grams: gramsFromWeight(r.s3eba3f653),
      method,
      stocked: !!r.s1e486b0c1,
      listed: !!r.s411a55b44,
      units_per_month: num(r.s3aa9c977e),
      extra: { ss_packaging_type: packType.raw, ss_packaging_label: packType.label },
    };
    let specId: string;
    if (existing.rows[0]) {
      specId = existing.rows[0].id;
      await query(
        `UPDATE packaging_product_specs SET product_title=$2, product_range=$3, length_mm=$4, width_mm=$5, height_mm=$6,
           length_packed_mm=$7, width_packed_mm=$8, height_packed_mm=$9, packed_dims_checked=$10, weight_grams=$11,
           method=$12, stocked=$13, listed=$14, units_per_month=$15, extra=$16, updated_at=NOW()
         WHERE id=$1`,
        [specId, spec.product_title, spec.product_range, spec.length_mm, spec.width_mm, spec.height_mm,
          spec.length_packed_mm, spec.width_packed_mm, spec.height_packed_mm, spec.packed_dims_checked,
          spec.weight_grams, spec.method, spec.stocked, spec.listed, spec.units_per_month, JSON.stringify(spec.extra)]
      );
    } else {
      specId = uuid();
      await query(
        `INSERT INTO packaging_product_specs (
           id, product_code, product_title, product_range, length_mm, width_mm, height_mm,
           length_packed_mm, width_packed_mm, height_packed_mm, packed_dims_checked, weight_grams,
           method, stocked, listed, units_per_month, smartsuite_id, extra
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [specId, spec.product_code, spec.product_title, spec.product_range, spec.length_mm, spec.width_mm, spec.height_mm,
          spec.length_packed_mm, spec.width_packed_mm, spec.height_packed_mm, spec.packed_dims_checked, spec.weight_grams,
          spec.method, spec.stocked, spec.listed, spec.units_per_month, r.id, JSON.stringify(spec.extra)]
      );
    }

    const boxSs = r.s705472882?.[0];
    const sleeveSs = r.sjefxxvo?.[0];
    const box = boxSs ? itemBySs.get(boxSs) : null;
    const setRec = sleeveSs ? sets.find((s: any) => s.id === sleeveSs) : null;

    const existingBom = await query(
      `SELECT id FROM packaging_boms WHERE product_code = $1 AND sku IS NULL AND option_rank = 1`,
      [r.title]
    );
    let bomId = existingBom.rows[0]?.id as string | undefined;
    if (!bomId && (box || setRec)) {
      bomId = uuid();
      await query(
        `INSERT INTO packaging_boms (id, product_code, method, option_rank, label, source)
         VALUES ($1,$2,$3,1,'Preferred','smartsuite_snapshot')`,
        [bomId, r.title, box ? 'box' : 'sleeve_tray']
      );
    }
    if (bomId && box) {
      await query(`DELETE FROM packaging_bom_lines WHERE bom_id = $1`, [bomId]);
      await query(
        `INSERT INTO packaging_bom_lines (id, bom_id, packaging_item_id, qty, qty_confirmed) VALUES ($1,$2,$3,1,true)`,
        [uuid(), bomId, box.id]
      );
      const boxRec = boxes.find((b: any) => b.id === boxSs);
      const edgeSs = boxRec?.sms4gavn?.[0];
      const edge = edgeSs ? itemBySs.get(edgeSs) : null;
      if (edge) {
        await query(
          `INSERT INTO packaging_bom_lines (id, bom_id, packaging_item_id, qty, qty_confirmed, notes)
           VALUES ($1,$2,$3,1,false,'Qty not in SmartSuite — confirm')`,
          [uuid(), bomId, edge.id]
        );
      }
      await link('product', r.title, 'item', box.code, 'uses_box');
    }
    if (bomId && setRec) {
      await query(`DELETE FROM packaging_bom_lines WHERE bom_id = $1`, [bomId]);
      const tray = setRec.s239sv1s?.[0] ? itemBySs.get(setRec.s239sv1s[0]) : null;
      const sleeve = setRec.sdltj60e?.[0] ? itemBySs.get(setRec.sdltj60e[0]) : null;
      const edge = setRec.s0dm08rw?.[0] ? itemBySs.get(setRec.s0dm08rw[0]) : null;
      for (const part of [tray, sleeve]) {
        if (!part) continue;
        await query(
          `INSERT INTO packaging_bom_lines (id, bom_id, packaging_item_id, qty, qty_confirmed) VALUES ($1,$2,$3,1,true)`,
          [uuid(), bomId, part.id]
        );
      }
      if (edge) {
        await query(
          `INSERT INTO packaging_bom_lines (id, bom_id, packaging_item_id, qty, qty_confirmed, notes)
           VALUES ($1,$2,$3,1,false,'Qty not in SmartSuite — confirm')`,
          [uuid(), bomId, edge.id]
        );
      }
      await link('product', r.title, 'sleeve_set', setRec.title, 'uses_sleeve_set');
    }
    bump('products', 'upserted');
  }

  return { dryRun: false, sourceDir: dir, counts };
}
