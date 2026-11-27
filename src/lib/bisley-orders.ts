/**
 * Bisley orders: one record of every weekly reorder workbook sent to Bisley, so the warehouse knows
 * what is on order, when it should arrive, and what is still bonded.
 *
 * A workbook has two sheets.
 *   Sheet 1 – New orders   lines Bisley should make and send. They are "order" lines and are expected in.
 *   Sheet 2 – Bonded stock lines sold from bonded stock. They are "bonded" lines: we pay for them and nothing comes in.
 *
 * Bonded stock is the stock on the two starting orders (see bonded-stock.ts). A bonded unit stays bonded until a
 * sheet 2 pays it off. Selling it and reordering it does not change that, because those reorders were not paid for,
 * so still bonded = starting units − units paid off, whatever is on the shelf.
 *
 * Arrival: received stock (RECEIVE movements) is matched to order lines per SKU, oldest sheet first, and only to
 * sheets sent before the stock came in. What is left is on order. Its estimated arrival is the send date plus the
 * factory lead time for the colour: palette 1 4-6 weeks, palette 2 6-8 weeks (the same windows the shop promises).
 * A sheet can carry Bisley's booked delivery date, which replaces the estimate, or be marked delivered.
 */
import XLSX from 'xlsx';
import { getPool, query } from '../db/index.js';
import { backorderWeeks, PALETTE_1_WEEKS } from './delivery-due.js';
import { ensureBondedStock } from './bonded-stock.js';

export type LineKind = 'order' | 'bonded';

export interface SheetLine {
  kind: LineKind;
  sku: string;
  quantity: number;
  unit_cost_gbp: number | null;
  line_cost_gbp: number | null;
  note: string | null;
}

export interface ParsedWorkbook {
  cut_off: string | null;
  lines: SheetLine[];
  sheets: { name: string; kind: LineKind; lines: number; units: number }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[£,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Which kind of lines a sheet holds, from its name: "1 – New orders" or "2 – Bonded stock". */
export function kindForSheet(name: string): LineKind | null {
  const n = name.trim().toLowerCase();
  if (/bonded/.test(n) || /^2\b/.test(n)) return 'bonded';
  if (/new orders?/.test(n) || /^1\b/.test(n) || /reorder|order/.test(n)) return 'order';
  return null;
}

/**
 * Lines from one sheet's rows (an array of rows, each an array of cells). The header row is the one with a "SKU" cell.
 * Order lines use "Reorder qty"; bonded lines use "Qty sold". Totals, custom lines and zero quantities are skipped.
 * Rows for the same SKU are added together (a line split by discount rate comes back as one).
 */
export function parseSheetRows(kind: LineKind, rows: unknown[][]): SheetLine[] {
  const headerAt = rows.findIndex((row) => row.some((cell) => String(cell ?? '').trim().toLowerCase() === 'sku'));
  if (headerAt < 0) return [];
  const header = rows[headerAt].map((cell) => String(cell ?? '').trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const skuCol = col('sku');
  const reorderCol = col('reorder qty', 'reorder quantity', 'qty to order', 'order qty');
  const soldCol = col('qty sold', 'quantity sold', 'sold');
  const qtyCol = kind === 'order' ? (reorderCol >= 0 ? reorderCol : col('qty', 'quantity')) : (soldCol >= 0 ? soldCol : col('qty', 'quantity'));
  const unitCol = col('unit cost', 'unit cost (gbp)', 'net each');
  const lineCol = col('line cost', 'line cost (gbp)', 'line total');
  const noteCol = col('note', 'notes');
  if (skuCol < 0 || qtyCol < 0) return [];

  const merged = new Map<string, SheetLine>();
  for (const row of rows.slice(headerAt + 1)) {
    const sku = String(row[skuCol] ?? '').trim();
    if (!sku || /^total/i.test(sku) || /^vat/i.test(sku) || sku.toUpperCase() === 'CUSTOM' || /\s/.test(sku)) continue;
    const quantity = Math.trunc(num(row[qtyCol]) ?? 0);
    if (quantity <= 0) continue;
    const unit = unitCol >= 0 ? num(row[unitCol]) : null;
    const lineCost = lineCol >= 0 ? num(row[lineCol]) : null;
    const note = noteCol >= 0 ? String(row[noteCol] ?? '').trim() : '';
    const key = sku.toLowerCase();
    const found = merged.get(key);
    if (found) {
      found.quantity += quantity;
      found.line_cost_gbp = found.line_cost_gbp === null && lineCost === null ? null : (found.line_cost_gbp ?? 0) + (lineCost ?? 0);
      if (note && !(found.note ?? '').includes(note)) found.note = found.note ? `${found.note}; ${note}` : note;
    } else {
      merged.set(key, { kind, sku, quantity, unit_cost_gbp: unit, line_cost_gbp: lineCost, note: note || null });
    }
  }
  return [...merged.values()].map((line) => ({
    ...line,
    line_cost_gbp: line.line_cost_gbp === null ? null : Math.round(line.line_cost_gbp * 100) / 100,
  }));
}

/** Both sheets of a weekly workbook, and the cut-off line if the sheet prints one. */
export function parseWorkbook(data: Buffer): ParsedWorkbook {
  const book = XLSX.read(data, { type: 'buffer' });
  const lines: SheetLine[] = [];
  const sheets: ParsedWorkbook['sheets'] = [];
  let cutOff: string | null = null;
  for (const name of book.SheetNames) {
    const kind = kindForSheet(name);
    if (!kind) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name], { header: 1, raw: true, defval: '' });
    if (!cutOff) {
      const cell = rows.flat().map((c) => String(c ?? '')).find((c) => /cut-?off/i.test(c));
      if (cell) cutOff = cell.trim().slice(0, 200);
    }
    const found = parseSheetRows(kind, rows);
    lines.push(...found);
    sheets.push({ name, kind, lines: found.length, units: found.reduce((sum, line) => sum + line.quantity, 0) });
  }
  return { cut_off: cutOff, lines, sheets };
}

export interface OrderLineRef { id: string; sku: string; quantity: number; sent_at: number }
export interface Receipt { sku: string; quantity: number; at: number }

/**
 * Bisley cannot turn an order round in under two weeks (the quickest seen, trays on 507216, took 18 days),
 * so stock that comes in sooner after a sheet was sent belongs to something else, such as the bonded
 * starting stock delivered in October, and is not counted against that sheet.
 */
export const MIN_LEAD_DAYS = 14;

/**
 * The order sheets count insert trays one by one under the 5-pack code (225P5-000 x 25 = five packs).
 * Stock-in books a 5-pack code in packs and single trays under the P1 code, so receipts are turned into
 * single trays under the 5-pack code before matching.
 */
export function receiptInTrays(receipt: Receipt): Receipt {
  if (/P5-000$/i.test(receipt.sku)) return { ...receipt, quantity: receipt.quantity * 5 };
  if (/^PIT\d+P1-000$/i.test(receipt.sku)) return { ...receipt, sku: receipt.sku.replace(/P1-000$/i, 'P5-000') };
  return receipt;
}

/**
 * Units received against each order line. Per SKU, each receipt fills the oldest open line that was sent
 * at least MIN_LEAD_DAYS before it came in. A receipt that matches no open line is ignored (it was for an
 * order this record does not hold).
 */
export function matchReceipts(lines: OrderLineRef[], receipts: Receipt[]): Map<string, number> {
  const received = new Map<string, number>();
  const bySku = new Map<string, OrderLineRef[]>();
  for (const line of lines) {
    const key = line.sku.toLowerCase();
    bySku.set(key, [...(bySku.get(key) ?? []), line]);
    received.set(line.id, 0);
  }
  for (const list of bySku.values()) list.sort((a, b) => a.sent_at - b.sent_at || a.id.localeCompare(b.id));
  for (const receipt of [...receipts].sort((a, b) => a.at - b.at)) {
    let left = receipt.quantity;
    for (const line of bySku.get(receipt.sku.toLowerCase()) ?? []) {
      if (left <= 0) break;
      if (line.sent_at + MIN_LEAD_DAYS * DAY_MS > receipt.at) break;
      const open = line.quantity - (received.get(line.id) ?? 0);
      if (open <= 0) continue;
      const take = Math.min(open, left);
      received.set(line.id, (received.get(line.id) ?? 0) + take);
      left -= take;
    }
  }
  return received;
}

export interface ArrivalWindow {
  basis: 'booked' | 'palette_1' | 'palette_2';
  earliest: string;
  latest: string;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** When an order line should arrive: Bisley's booked date when there is one, otherwise send date + palette lead time. */
export function arrivalWindow(sentAt: number, sku: string, bookedFor: string | null): ArrivalWindow {
  if (bookedFor) return { basis: 'booked', earliest: bookedFor, latest: bookedFor };
  const weeks = backorderWeeks(sku);
  const day = Date.UTC(new Date(sentAt).getUTCFullYear(), new Date(sentAt).getUTCMonth(), new Date(sentAt).getUTCDate());
  return {
    basis: weeks === PALETTE_1_WEEKS ? 'palette_1' : 'palette_2',
    earliest: isoDay(day + weeks.min * 7 * DAY_MS),
    latest: isoDay(day + weeks.max * 7 * DAY_MS),
  };
}

/** Monday of the week holding this YYYY-MM-DD date. */
export function weekStarting(day: string): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  const dow = (new Date(ms).getUTCDay() + 6) % 7;
  return isoDay(ms - dow * DAY_MS);
}

/** Bonded units left on a SKU: starting units less units paid off, never below nothing. */
export function stillBonded(starting: number, paidOff: number): { still: number; over: number } {
  return { still: Math.max(0, starting - paidOff), over: Math.max(0, paidOff - starting) };
}

// ---------------------------------------------------------------------------------------------- database

let ready: Promise<void> | null = null;

export function ensureBisleyOrders(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS bisley_order_sheets (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          ref VARCHAR(200) NOT NULL UNIQUE,
          sent_at TIMESTAMPTZ NOT NULL,
          cut_off VARCHAR(200),
          sent_to VARCHAR(255),
          bisley_ref VARCHAR(100),
          booked_for DATE,
          delivered_at DATE,
          file_name VARCHAR(255),
          source VARCHAR(40),
          note TEXT,
          created_by VARCHAR(255),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await query(`
        CREATE TABLE IF NOT EXISTS bisley_order_lines (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          sheet_id UUID NOT NULL REFERENCES bisley_order_sheets(id) ON DELETE CASCADE,
          kind VARCHAR(10) NOT NULL CHECK (kind IN ('order', 'bonded')),
          sku VARCHAR(120) NOT NULL,
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          unit_cost_gbp NUMERIC(12, 4),
          line_cost_gbp NUMERIC(12, 2),
          note TEXT
        )`);
      await query(`CREATE INDEX IF NOT EXISTS idx_bisley_order_lines_sheet ON bisley_order_lines (sheet_id)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_bisley_order_lines_sku ON bisley_order_lines (LOWER(sku), kind)`);
    })().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

export interface SheetInput {
  ref: string;
  sent_at: string;
  cut_off?: string | null;
  sent_to?: string | null;
  bisley_ref?: string | null;
  booked_for?: string | null;
  file_name?: string | null;
  source?: string | null;
  note?: string | null;
  lines: SheetLine[];
}

/**
 * Save a sheet. The ref names the workbook (its send date and cut-off), so saving the same workbook again
 * replaces its lines of the kinds sent, and leaves the other kind alone.
 */
export async function saveSheet(input: SheetInput, actor: string): Promise<{ id: string; order_lines: number; bonded_lines: number }> {
  await ensureBisleyOrders();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const sheet = await client.query(
      `INSERT INTO bisley_order_sheets (ref, sent_at, cut_off, sent_to, bisley_ref, booked_for, file_name, source, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (ref) DO UPDATE SET
         sent_at = EXCLUDED.sent_at,
         cut_off = COALESCE(EXCLUDED.cut_off, bisley_order_sheets.cut_off),
         sent_to = COALESCE(EXCLUDED.sent_to, bisley_order_sheets.sent_to),
         bisley_ref = COALESCE(EXCLUDED.bisley_ref, bisley_order_sheets.bisley_ref),
         booked_for = COALESCE(EXCLUDED.booked_for, bisley_order_sheets.booked_for),
         file_name = COALESCE(EXCLUDED.file_name, bisley_order_sheets.file_name),
         source = EXCLUDED.source,
         note = COALESCE(EXCLUDED.note, bisley_order_sheets.note),
         updated_at = NOW()
       RETURNING id`,
      [input.ref, input.sent_at, input.cut_off ?? null, input.sent_to ?? null, input.bisley_ref ?? null,
        input.booked_for ?? null, input.file_name ?? null, input.source ?? 'upload', input.note ?? null, actor],
    );
    const id = sheet.rows[0].id as string;
    const kinds = [...new Set(input.lines.map((line) => line.kind))];
    if (kinds.length) await client.query(`DELETE FROM bisley_order_lines WHERE sheet_id = $1 AND kind = ANY($2::text[])`, [id, kinds]);
    for (const line of input.lines) {
      await client.query(
        `INSERT INTO bisley_order_lines (sheet_id, kind, sku, quantity, unit_cost_gbp, line_cost_gbp, note) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, line.kind, line.sku, line.quantity, line.unit_cost_gbp, line.line_cost_gbp, line.note],
      );
    }
    await client.query('COMMIT');
    return { id, order_lines: input.lines.filter((l) => l.kind === 'order').length, bonded_lines: input.lines.filter((l) => l.kind === 'bonded').length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** SQL for units paid off per SKU (lower-cased), for use as a sub-query. */
export const PAID_OFF_SQL = `SELECT LOWER(l.sku) AS sku, SUM(l.quantity)::int AS paid
  FROM bisley_order_lines l WHERE l.kind = 'bonded' GROUP BY LOWER(l.sku)`;

/** Everything the reorders page shows: sheets, what is on order and when, and the bonded balance. */
export async function bisleyOrdersOverview() {
  await Promise.all([ensureBisleyOrders(), ensureBondedStock()]);
  const [sheetsRes, linesRes, costsRes, stockRes, bondedRes] = await Promise.all([
    query(`SELECT id, ref, sent_at, cut_off, sent_to, bisley_ref, booked_for::text AS booked_for, delivered_at::text AS delivered_at,
                  file_name, source, note FROM bisley_order_sheets ORDER BY sent_at`),
    query(`SELECT l.id, l.sheet_id, l.kind, l.sku, l.quantity, l.unit_cost_gbp::float8 AS unit_cost_gbp,
                  l.line_cost_gbp::float8 AS line_cost_gbp, l.note FROM bisley_order_lines l`),
    query(`SELECT LOWER(variant_sku) AS sku, MAX(unit_cost_gbp)::float8 AS cost, MAX(product_title) AS title, MAX(colour_name) AS colour
             FROM wms_products GROUP BY LOWER(variant_sku)`),
    query(`SELECT LOWER(product_sku) AS sku, SUM(quantity)::int AS qty FROM warehouse_inventory WHERE quantity > 0 GROUP BY LOWER(product_sku)`),
    query(`SELECT product_sku AS sku, units FROM bonded_stock`),
  ]);
  type Sheet = { id: string; ref: string; sent_at: Date; cut_off: string | null; sent_to: string | null; bisley_ref: string | null;
    booked_for: string | null; delivered_at: string | null; file_name: string | null; source: string | null; note: string | null };
  type Line = { id: string; sheet_id: string; kind: LineKind; sku: string; quantity: number; unit_cost_gbp: number | null; line_cost_gbp: number | null; note: string | null };
  const sheets = sheetsRes.rows as Sheet[];
  const lines = linesRes.rows as Line[];
  const product = new Map<string, { cost: number | null; title: string | null; colour: string | null }>(
    costsRes.rows.map((r: { sku: string; cost: number | null; title: string | null; colour: string | null }) => [r.sku, r]),
  );
  const onHand = new Map<string, number>(stockRes.rows.map((r: { sku: string; qty: number }) => [r.sku, Number(r.qty)]));
  const sheetById = new Map(sheets.map((s) => [s.id, s]));
  const unitCost = (line: Line) => line.unit_cost_gbp ?? product.get(line.sku.toLowerCase())?.cost ?? null;
  const lineValue = (line: Line, units: number) => {
    if (line.line_cost_gbp !== null && units === line.quantity) return line.line_cost_gbp;
    const cost = unitCost(line);
    return cost === null ? null : Math.round(cost * units * 100) / 100;
  };

  // Receipts since the first sheet was sent
  const orderLines = lines.filter((l) => l.kind === 'order');
  const first = sheets.length ? new Date(sheets[0].sent_at).getTime() : Date.now();
  const receiptsRes = orderLines.length
    ? await query(
      // Bin-to-bin moves are logged as RECEIVE with a "Moved from" note; they are not deliveries
      `SELECT product_sku AS sku, quantity::int AS quantity, COALESCE(movement_date, created_at) AS created_at FROM warehouse_movements
        WHERE movement_type = 'RECEIVE' AND quantity > 0 AND COALESCE(movement_date, created_at) >= $1
          AND COALESCE(notes, '') NOT ILIKE 'Moved from%'`,
      [new Date(first + MIN_LEAD_DAYS * DAY_MS - DAY_MS)],
    )
    : { rows: [] };
  const received = matchReceipts(
    orderLines.map((l) => ({ id: l.id, sku: l.sku, quantity: l.quantity, sent_at: new Date(sheetById.get(l.sheet_id)!.sent_at).getTime() })),
    receiptsRes.rows.map((r: { sku: string; quantity: number; created_at: Date }) => receiptInTrays({ sku: r.sku, quantity: Number(r.quantity), at: new Date(r.created_at).getTime() })),
  );

  const today = isoDay(Date.now());
  const incoming: (ArrivalWindow & {
    line_id: string; sheet_id: string; sheet_ref: string; sent_at: Date; bisley_ref: string | null; sku: string;
    title: string | null; colour: string | null; ordered: number; received: number; open: number;
    value_gbp: number | null; overdue: boolean; note: string | null;
  })[] = [];
  for (const line of orderLines) {
    const sheet = sheetById.get(line.sheet_id)!;
    const got = sheet.delivered_at ? line.quantity : Math.min(line.quantity, received.get(line.id) ?? 0);
    const open = line.quantity - got;
    if (open <= 0) continue;
    const window = arrivalWindow(new Date(sheet.sent_at).getTime(), line.sku, sheet.booked_for);
    const meta = product.get(line.sku.toLowerCase());
    incoming.push({
      line_id: line.id,
      sheet_id: sheet.id,
      sheet_ref: sheet.ref,
      sent_at: sheet.sent_at,
      bisley_ref: sheet.bisley_ref,
      sku: line.sku,
      title: meta?.title ?? null,
      colour: meta?.colour ?? null,
      ordered: line.quantity,
      received: got,
      open,
      value_gbp: lineValue(line, open),
      ...window,
      overdue: window.latest < today,
      note: line.note,
    });
  }
  incoming.sort((a, b) => a.earliest.localeCompare(b.earliest) || a.sku.localeCompare(b.sku));

  const weeks = new Map<string, { week: string; units: number; value_gbp: number; lines: number; overdue_units: number; booked_units: number }>();
  for (const row of incoming) {
    const week = row.overdue ? 'overdue' : weekStarting(row.earliest < today ? today : row.earliest);
    const bucket = weeks.get(week) ?? { week, units: 0, value_gbp: 0, lines: 0, overdue_units: 0, booked_units: 0 };
    bucket.units += row.open;
    bucket.value_gbp += row.value_gbp ?? 0;
    bucket.lines += 1;
    if (row.overdue) bucket.overdue_units += row.open;
    if (row.basis === 'booked') bucket.booked_units += row.open;
    weeks.set(week, bucket);
  }
  const timeline = [...weeks.values()]
    .map((w) => ({ ...w, value_gbp: Math.round(w.value_gbp * 100) / 100 }))
    .sort((a, b) => (a.week === 'overdue' ? -1 : b.week === 'overdue' ? 1 : a.week.localeCompare(b.week)));

  // Bonded balance
  const paid = new Map<string, number>();
  const paidValue = new Map<string, number>();
  for (const line of lines.filter((l) => l.kind === 'bonded')) {
    const key = line.sku.toLowerCase();
    paid.set(key, (paid.get(key) ?? 0) + line.quantity);
    paidValue.set(key, (paidValue.get(key) ?? 0) + (lineValue(line, line.quantity) ?? 0));
  }
  const starting = new Map<string, { sku: string; units: number }>(
    (bondedRes.rows as { sku: string; units: number }[]).map((r) => [r.sku.toLowerCase(), { sku: r.sku, units: Number(r.units) }]),
  );
  const bonded = [...starting.entries()].map(([key, row]) => {
    const p = paid.get(key) ?? 0;
    const { still, over } = stillBonded(row.units, p);
    const meta = product.get(key);
    const cost = meta?.cost ?? null;
    const shelf = onHand.get(key) ?? 0;
    return {
      sku: row.sku,
      title: meta?.title ?? null,
      colour: meta?.colour ?? null,
      starting: row.units,
      paid_off: Math.min(p, row.units),
      over_paid: over,
      still_bonded: still,
      on_hand: shelf,
      not_on_shelf: Math.max(0, still - shelf),
      unit_cost_gbp: cost,
      still_value_gbp: cost === null ? null : Math.round(cost * still * 100) / 100,
    };
  }).sort((a, b) => (b.still_value_gbp ?? 0) - (a.still_value_gbp ?? 0) || a.sku.localeCompare(b.sku));
  const notBonded = [...paid.entries()].filter(([key]) => !starting.has(key)).map(([key, units]) => ({
    sku: lines.find((l) => l.kind === 'bonded' && l.sku.toLowerCase() === key)!.sku,
    units,
    value_gbp: Math.round((paidValue.get(key) ?? 0) * 100) / 100,
    sheets: [...new Set(lines.filter((l) => l.kind === 'bonded' && l.sku.toLowerCase() === key).map((l) => sheetById.get(l.sheet_id)!.ref))],
  }));
  const sum = (rows: Record<string, unknown>[], field: string) => Math.round(rows.reduce((total, row) => total + (Number(row[field]) || 0), 0) * 100) / 100;
  const startingValue = bonded.reduce((total, row) => total + (row.unit_cost_gbp ?? 0) * row.starting, 0);
  const paidOffValue = bonded.reduce((total, row) => total + (row.unit_cost_gbp ?? 0) * row.paid_off, 0);
  const notOnShelfValue = bonded.reduce((total, row) => total + (row.unit_cost_gbp ?? 0) * row.not_on_shelf, 0);

  const sheetRows = sheets.map((sheet) => {
    const mine = lines.filter((l) => l.sheet_id === sheet.id);
    const ordered = mine.filter((l) => l.kind === 'order');
    const bondedLines = mine.filter((l) => l.kind === 'bonded');
    const openUnits = incoming.filter((row) => row.sheet_id === sheet.id).reduce((total, row) => total + row.open, 0);
    const value = (rows: Line[]) => Math.round(rows.reduce((total, l) => total + (lineValue(l, l.quantity) ?? 0), 0) * 100) / 100;
    return {
      ...sheet,
      order_lines: ordered.length,
      order_units: ordered.reduce((total, l) => total + l.quantity, 0),
      order_value_gbp: value(ordered),
      bonded_lines: bondedLines.length,
      bonded_units: bondedLines.reduce((total, l) => total + l.quantity, 0),
      bonded_value_gbp: value(bondedLines),
      open_units: openUnits,
      status: sheet.delivered_at ? 'delivered' : !ordered.length ? 'no_order_lines' : openUnits === 0 ? 'received' : openUnits < ordered.reduce((t, l) => t + l.quantity, 0) ? 'part_received' : 'on_order',
    };
  }).reverse();

  return {
    generated_at: new Date().toISOString(),
    lead_times: { palette_1: '4-6 weeks', palette_2: '6-8 weeks' },
    sheets: sheetRows,
    incoming,
    timeline,
    bonded: {
      rows: bonded,
      not_bonded: notBonded,
      totals: {
        skus: bonded.length,
        starting_units: bonded.reduce((t, r) => t + r.starting, 0),
        starting_value_gbp: Math.round(startingValue * 100) / 100,
        paid_off_units: bonded.reduce((t, r) => t + r.paid_off, 0),
        paid_off_value_gbp: Math.round(paidOffValue * 100) / 100,
        still_units: bonded.reduce((t, r) => t + r.still_bonded, 0),
        still_value_gbp: sum(bonded, 'still_value_gbp'),
        not_on_shelf_units: bonded.reduce((t, r) => t + r.not_on_shelf, 0),
        not_on_shelf_value_gbp: Math.round(notOnShelfValue * 100) / 100,
      },
    },
  };
}
