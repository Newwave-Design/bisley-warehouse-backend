/**
 * Desk stock reconciliation: put stock under the right SKU when it was received under the wrong one,
 * re-point a typed barcode together with its stock, and undo either.
 *
 * Every move is one transaction with two ADJUST movements and a stock_reconciliations row, so it is logged,
 * explains itself in the movement notes, and can be reversed. Reserved units never move: only what is free
 * in one bay is moved at a time.
 */
import { getPool } from '../db/index.js';

export class ReconcileError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

type Db = { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export interface MoveRequest {
  fromSku: string;
  toSku: string;
  quantity: number;
  locationId?: string | null;
  reason?: string | null;
  userId: string | null;
  email?: string | null;
  /** The reconciliation this one undoes. */
  reversesId?: string | null;
}

export interface MoveResult {
  id: string;
  fromSku: string;
  toSku: string;
  quantity: number;
  locationId: string;
}

const MAX_QTY = 100000;

/** Moves free stock of one SKU to another SKU in the same bay. Runs inside the caller's transaction. */
export async function moveStockBetweenSkus(db: Db, p: MoveRequest): Promise<MoveResult> {
  const from = String(p.fromSku || '').trim();
  const to = String(p.toSku || '').trim();
  const qty = Math.trunc(Number(p.quantity));
  if (!from || !to) throw new ReconcileError('Both SKUs are needed');
  if (from.toUpperCase() === to.toUpperCase()) throw new ReconcileError('That is the same SKU');
  if (to.length > 50) throw new ReconcileError('The new SKU is too long');
  if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_QTY) throw new ReconcileError('Enter a quantity of 1 or more');
  if (!p.userId) throw new ReconcileError('This login cannot be recorded against a stock move. Sign in with your own account.', 403);

  const src = await db.query(
    `SELECT wi.id, wi.location_id, wi.product_sku, wi.colour_code, wi.quantity, wi.quantity_reserved, wi.liability_status, wl.location_code
       FROM warehouse_inventory wi JOIN warehouse_locations wl ON wl.id = wi.location_id
      WHERE upper(wi.product_sku) = upper($1) AND wi.quantity > 0 AND ($2::uuid IS NULL OR wi.location_id = $2::uuid)
      ORDER BY wi.quantity DESC
      FOR UPDATE OF wi`,
    [from, p.locationId || null],
  );
  const row = src.rows[0];
  if (!row) throw new ReconcileError(`None of ${from} is on the shelf${p.locationId ? ' in that bay' : ''}`, 409);
  const free = Number(row.quantity) - Number(row.quantity_reserved);
  if (free < qty) {
    throw new ReconcileError(`Only ${Math.max(0, free)} of ${row.product_sku} is free in ${row.location_code} (${row.quantity_reserved} reserved for orders). Move less, or from one bay at a time.`, 409);
  }

  // Keep the spelling the shelf or the catalogue already uses for the target SKU
  const known = await db.query(
    `SELECT sku FROM (
        SELECT product_sku AS sku, 1 AS rank FROM warehouse_inventory WHERE upper(product_sku) = upper($1)
        UNION ALL
        SELECT variant_sku, 2 FROM wms_products WHERE upper(variant_sku) = upper($1) AND NOT COALESCE(is_archived, false)
      ) s ORDER BY rank LIMIT 1`,
    [to],
  );
  const target = known.rows[0]?.sku ?? to.toUpperCase();
  const colour = row.colour_code ?? null;

  const rec = await db.query(
    `INSERT INTO stock_reconciliations (from_sku, to_sku, location_id, quantity, reason, performed_by, performed_by_email, reverses_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [row.product_sku, target, row.location_id, qty, (p.reason || '').trim().slice(0, 500) || null, p.userId, p.email ?? null, p.reversesId ?? null],
  );
  const id: string = rec.rows[0].id;
  const note = `Reconcile ${id.slice(0, 8)}: ${row.product_sku} to ${target}${p.reason ? `. ${String(p.reason).trim().slice(0, 200)}` : ''}`;

  await db.query(`UPDATE warehouse_inventory SET quantity = quantity - $1, updated_at = NOW() WHERE id = $2`, [qty, row.id]);
  await db.query(
    `INSERT INTO warehouse_inventory (location_id, product_sku, colour_code, quantity, liability_status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (location_id, product_sku, COALESCE(colour_code, ''))
     DO UPDATE SET quantity = warehouse_inventory.quantity + $4, updated_at = NOW()`,
    [row.location_id, target, colour, qty, row.liability_status],
  );
  await db.query(
    `INSERT INTO warehouse_movements (movement_type, location_id, product_sku, colour_code, quantity, notes, performed_by)
     VALUES ('ADJUST', $1, $2, $3, $4, $5, $6), ('ADJUST', $1, $7, $3, $8, $5, $6)`,
    [row.location_id, row.product_sku, colour, -qty, note, p.userId, target, qty],
  );
  return { id, fromSku: row.product_sku, toSku: target, quantity: qty, locationId: row.location_id };
}

/** Run [work] in its own transaction unless the caller already has one. */
export async function inTransaction<T>(existing: Db | undefined, work: (db: Db) => Promise<T>): Promise<T> {
  if (existing) return work(existing);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await work(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Reverses a move, if the stock it created is still free where it went. */
export async function undoReconciliation(id: string, userId: string | null, email: string | null, existing?: Db): Promise<MoveResult> {
  return inTransaction(existing, async (db) => {
    const found = await db.query(`SELECT * FROM stock_reconciliations WHERE id = $1 FOR UPDATE`, [id]);
    const r = found.rows[0];
    if (!r) throw new ReconcileError('Reconciliation not found', 404);
    if (r.undone_at) throw new ReconcileError('That has already been undone', 409);
    let back: MoveResult;
    try {
      back = await moveStockBetweenSkus(db, {
        fromSku: r.to_sku, toSku: r.from_sku, quantity: r.quantity, locationId: r.location_id,
        reason: `Undo of ${String(r.id).slice(0, 8)}`, userId, email, reversesId: r.id,
      });
    } catch (err) {
      if (err instanceof ReconcileError && err.status === 409) {
        throw new ReconcileError(`Cannot undo: the ${r.quantity} moved to ${r.to_sku} is no longer all free in that bay. ${err.message}`, 409);
      }
      throw err;
    }
    await db.query(`UPDATE stock_reconciliations SET undone_at = NOW(), undone_by = $2 WHERE id = $1`, [id, email]);
    return back;
  });
}

export interface RemapRequest {
  barcode: string;
  /** A catalogue SKU to move the barcode to; empty keeps the typed SKU as it is. */
  sku?: string | null;
  /** Also move this many units from the old SKU to the new one. */
  moveQuantity?: number;
  userId: string | null;
  email: string | null;
}

/** The desk's check of a typed SKU: re-point the barcode and, if asked, the stock received under it. All or nothing. */
export async function remapBarcode(p: RemapRequest, existing?: Db): Promise<{ sku: string | null; moved: MoveResult | null }> {
  return inTransaction(existing, async (db) => {
    const barcode = String(p.barcode || '').trim();
    if (!barcode) throw new ReconcileError('barcode required');
    const current = await db.query(`SELECT product_sku FROM barcode_mappings WHERE barcode = $1 AND needs_review = true FOR UPDATE`, [barcode]);
    if (!current.rows[0]) throw new ReconcileError('Nothing to check for that barcode', 404);
    const oldSku: string = current.rows[0].product_sku;
    const sku = String(p.sku || '').trim();
    if (!sku) {
      await db.query(
        `UPDATE barcode_mappings SET needs_review = false, reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW() WHERE barcode = $1`,
        [barcode, p.email],
      );
      return { sku: null, moved: null };
    }
    const product = await db.query(
      `SELECT variant_sku, product_title, colour_code, colour_name, variant_thumbnail, medusa_product_id, medusa_variant_id
         FROM wms_products WHERE upper(variant_sku) = upper($1) ORDER BY is_archived ASC LIMIT 1`,
      [sku],
    );
    const prod = product.rows[0];
    if (!prod) throw new ReconcileError(`Product not found: ${sku}`, 404);
    await db.query(
      `UPDATE barcode_mappings SET product_sku = $2, colour_code = $3, colour_name = $4, product_name = $5, thumbnail_url = $6,
              medusa_product_id = $7, medusa_variant_id = $8, needs_review = false, reviewed_by = $9, reviewed_at = NOW(), updated_at = NOW()
        WHERE barcode = $1`,
      [barcode, prod.variant_sku, prod.colour_code, prod.colour_name, prod.product_title, prod.variant_thumbnail, prod.medusa_product_id, prod.medusa_variant_id, p.email],
    );
    let moved: MoveResult | null = null;
    if (p.moveQuantity && p.moveQuantity > 0 && oldSku.toUpperCase() !== String(prod.variant_sku).toUpperCase()) {
      moved = await moveStockBetweenSkus(db, {
        fromSku: oldSku, toSku: prod.variant_sku, quantity: p.moveQuantity,
        reason: `Typed SKU ${oldSku} checked on the desk`, userId: p.userId, email: p.email,
      });
    }
    return { sku: prod.variant_sku, moved };
  });
}

/** What the Reconcile page lists. */
export async function reconcileOverview(db: Db) {
  const parts = await db.query(
    `WITH shelf AS (
       SELECT upper(wi.product_sku) AS sku, SUM(wi.quantity)::int AS qty, SUM(wi.quantity_reserved)::int AS reserved,
              (array_agg(wl.location_code ORDER BY wi.quantity DESC))[1] AS bay,
              (array_agg(wi.location_id ORDER BY wi.quantity DESC))[1] AS location_id
         FROM warehouse_inventory wi JOIN warehouse_locations wl ON wl.id = wi.location_id
        WHERE wi.quantity > 0 GROUP BY 1)
     SELECT s.sku, s.qty, s.reserved, s.bay, s.location_id,
            (SELECT COALESCE(SUM(a.qty), 0)::int FROM custom_line_arrivals a WHERE a.consumed_at IS NULL AND upper(a.sku) = s.sku) AS allocated,
            (SELECT bm.product_name FROM barcode_mappings bm WHERE upper(bm.product_sku) = s.sku AND bm.product_name IS NOT NULL ORDER BY bm.updated_at DESC LIMIT 1) AS description,
            EXISTS (SELECT 1 FROM barcode_mappings bm WHERE upper(bm.product_sku) = s.sku AND bm.needs_review) AS needs_review
       FROM shelf s
      WHERE NOT EXISTS (SELECT 1 FROM wms_products wp WHERE upper(wp.variant_sku) = s.sku AND NOT COALESCE(wp.is_archived, false))
      ORDER BY s.sku
      LIMIT 500`,
  );
  const spare = parts.rows
    .map((r: any) => ({ ...r, spare: Math.max(0, Number(r.qty) - Number(r.allocated)) }))
    .filter((r: any) => r.spare > 0);

  const reviews = await db.query(
    `SELECT bm.barcode, bm.product_sku, bm.product_name, bm.assigned_by, bm.updated_at,
            (SELECT COALESCE(SUM(wi.quantity - wi.quantity_reserved), 0)::int FROM warehouse_inventory wi WHERE upper(wi.product_sku) = upper(bm.product_sku)) AS free_on_shelf
       FROM barcode_mappings bm WHERE bm.needs_review = true ORDER BY bm.updated_at DESC LIMIT 200`,
  );
  const recent = await db.query(
    `SELECT r.id, r.from_sku, r.to_sku, r.quantity, r.reason, r.performed_by_email, r.created_at, r.undone_at, r.reverses_id, wl.location_code
       FROM stock_reconciliations r LEFT JOIN warehouse_locations wl ON wl.id = r.location_id
      ORDER BY r.created_at DESC LIMIT 25`,
  );
  return { parts: spare, reviews: reviews.rows, recent: recent.rows };
}

/** Shelf search for the SKU pickers: any SKU with free stock whose code or description contains the text. */
export async function searchShelf(db: Db, text: string) {
  const q = String(text || '').trim();
  if (q.length < 2) return [];
  const rows = await db.query(
    `SELECT upper(wi.product_sku) AS sku, SUM(wi.quantity)::int AS qty, SUM(wi.quantity - wi.quantity_reserved)::int AS free,
            (SELECT bm.product_name FROM barcode_mappings bm WHERE upper(bm.product_sku) = upper(wi.product_sku) AND bm.product_name IS NOT NULL ORDER BY bm.updated_at DESC LIMIT 1) AS description
       FROM warehouse_inventory wi
      WHERE wi.quantity > 0 AND (wi.product_sku ILIKE $1 OR EXISTS (
              SELECT 1 FROM barcode_mappings bm WHERE upper(bm.product_sku) = upper(wi.product_sku) AND bm.product_name ILIKE $1))
      GROUP BY upper(wi.product_sku), wi.product_sku
      ORDER BY 1 LIMIT 20`,
    [`%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`],
  );
  return rows.rows;
}
