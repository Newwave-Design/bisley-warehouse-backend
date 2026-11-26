/**
 * Returns desk from the 19 Nov 2026 design.
 * Stock increases only after an unopened item is scanned, the bay is scanned, and Confirm unopened is ticked.
 * A decision does not change stock. Refunds go to the shop when it is configured; otherwise the failure is logged.
 * A claim pack is a zip the desk can download. Staging does not post it to a live carrier.
 */
import express, { Response } from 'express';
import { query, getPool } from '../../db/index.js';
import { authMiddleware, requirePermission, AuthRequest } from '../../middleware/auth.js';
import { issueRefund, RefundError } from '../../lib/refunds.js';
import { isStaging } from '../../lib/staging.js';
import { toUuidOrNull } from './mobile.js';
import { withRmaNumber } from '../../lib/return-desk-mirror.js';
import { canScanIntoStock, codeMatchesItem, decisionChangesStock, decisionStockEffect, deskAfterDecisions, ITEM_DECISIONS, nextDeskStatus, refundWaitsForInspection, scanInUnits, soldStockTreatment, unitsToDecide, RETURN_REASONS } from '../../lib/returns-desk-rules.js';
import { buildClaimPack } from '../../lib/return-claim-pack.js';
import { splitKitForReturn } from '../../lib/return-kits.js';
import { stockArrived } from './stock-in.js';
import { returnProgress, RETURN_STEPS, type ReturnCollection } from '../../lib/return-progress.js';
import { returnKind } from '../../lib/return-kind.js';
import { canRaiseClaim, evidenceChecklist, isClaimKind, isClaimStatus, isFault, isPhotoKind, suggestFault, FAULTS, PHOTO_KINDS, CLAIM_STATUSES } from '../../lib/return-fault.js';

const router = express.Router();
router.use(authMiddleware);
// Reading is open to anyone signed in. Starting, receiving, inspecting and scanning stock in need the orders permission
// (every warehouse user has it). Deciding and refunding are still admin only, checked in the route.
router.use((req: AuthRequest, res: Response, next) => (req.method === 'GET' || req.method === 'HEAD' ? next() : requirePermission('manage_orders')(req, res, next)));

function admin(req: AuthRequest) {
  return String(req.user?.role || '').toUpperCase() === 'ADMIN' || String(req.user?.role || '').toUpperCase() === 'MANAGER';
}

router.get('/search', async (req: AuthRequest, res: Response) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ orders: [] });
  const like = `%${q}%`;
  const rows = await query(
    `SELECT pl.id, pl.pick_list_number, pl.customer_name, pl.status, pl.medusa_order_id, pl.shipping_address,
            COALESCE(json_agg(json_build_object('sku', pli.product_sku, 'qty', pli.quantity_required, 'title', pli.item_title))
              FILTER (WHERE pli.id IS NOT NULL), '[]') AS lines
     FROM pick_lists pl
     LEFT JOIN pick_list_items pli ON pli.pick_list_id = pl.id AND NOT COALESCE(pli.is_archived, false)
     WHERE pl.pick_list_number ILIKE $1 OR pl.customer_name ILIKE $1 OR pli.product_sku ILIKE $1
     GROUP BY pl.id
     ORDER BY pl.created_at DESC
     LIMIT 20`,
    [like]
  );
  res.json({ orders: rows.rows });
});

router.get('/', async (req: AuthRequest, res: Response) => {
  const tab = String(req.query.tab || 'open');
  const where = tab === 'closed'
    ? `ra.desk_status = 'closed'`
    : tab === 'claims'
      ? `(ra.desk_status = 'claim' OR EXISTS (SELECT 1 FROM return_claims c WHERE c.return_authorization_id = ra.id AND COALESCE(c.status, 'open') NOT IN ('paid', 'rejected', 'withdrawn')))`
      : `COALESCE(ra.desk_status, 'due_back') <> 'closed'`;
  const rows = await query(
    `SELECT ra.*, COALESCE(json_agg(ri.*) FILTER (WHERE ri.id IS NOT NULL), '[]') AS items,
            COALESCE((
              SELECT json_agg(json_build_object('id', p.id, 'item_id', p.return_item_id, 'kind', COALESCE(p.photo_kind, 'item'), 'sku', p.sku, 'caption', p.caption) ORDER BY p.created_at)
                FROM return_desk_photos p WHERE p.return_authorization_id = ra.id
            ), '[]') AS photos,
            COALESCE((
              SELECT json_agg(json_build_object('id', c.id, 'kind', c.kind, 'status', COALESCE(c.status, 'open'), 'note', c.note, 'override_note', c.override_note, 'created_by', c.created_by, 'created_at', c.created_at, 'report_name', c.report_name) ORDER BY c.created_at)
                FROM return_claims c WHERE c.return_authorization_id = ra.id
            ), '[]') AS claims
     FROM return_authorizations ra
     LEFT JOIN return_items ri ON ri.return_authorization_id = ra.id
     WHERE ${where}
     GROUP BY ra.id
     ORDER BY ra.created_at DESC
     LIMIT 200`
  );
  // The courier collection booked for each return, so the screen can say where it has got to.
  const pickIds = [...new Set(rows.rows.map((row: { pick_list_id?: string }) => row.pick_list_id).filter(Boolean))];
  const bookings = pickIds.length
    ? await query(
        `SELECT DISTINCT ON (pick_list_id) pick_list_id, courier, waybill, collection_date, service_name
           FROM collection_bookings
          WHERE pick_list_id = ANY($1::uuid[]) AND status <> 'cancelled' AND direction = 'return'
          ORDER BY pick_list_id, created_at DESC`,
        [pickIds]
      )
    : { rows: [] as (ReturnCollection & { pick_list_id: string })[] };
  const byPick = new Map<string, ReturnCollection>();
  for (const row of bookings.rows as (ReturnCollection & { pick_list_id: string })[]) byPick.set(row.pick_list_id, row);
  // What was asked for on the order: the order number, each requested line with its title and who raised it,
  // and the photos attached to those requests (they live apart from the photos taken at inspection).
  const orders = pickIds.length
    ? await query(
        `SELECT pl.id, pl.pick_list_number, pl.status AS order_status,
                COALESCE((
                  SELECT json_agg(json_build_object('sku', r.sku, 'title', pli.item_title, 'qty', pli.quantity_required, 'outcome', r.outcome,
                                                    'status', r.status, 'created_by', r.created_by, 'created_at', r.created_at) ORDER BY r.created_at, r.sku)
                    FROM return_requests r
                    LEFT JOIN LATERAL (
                      SELECT item_title, quantity_required FROM pick_list_items
                       WHERE pick_list_id = r.pick_list_id AND product_sku = r.sku AND NOT COALESCE(is_archived, false)
                       ORDER BY line_number LIMIT 1
                    ) pli ON true
                   WHERE r.pick_list_id = pl.id AND r.status <> 'cancelled'
                ), '[]'::json) AS request_lines,
                COALESCE((
                  SELECT json_agg(json_build_object('id', i.id, 'sku', r.sku, 'created_by', i.created_by, 'created_at', i.created_at) ORDER BY i.created_at)
                    FROM return_request_images i JOIN return_requests r ON r.id = i.return_request_id
                   WHERE r.pick_list_id = pl.id AND r.status <> 'cancelled'
                ), '[]'::json) AS request_photos
           FROM pick_lists pl WHERE pl.id = ANY($1::uuid[])`,
        [pickIds]
      )
    : { rows: [] as Record<string, unknown>[] };
  const byOrder = new Map<string, Record<string, unknown>>(orders.rows.map((row: Record<string, unknown>) => [String(row.id), row]));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  const returns = rows.rows.map((row: { pick_list_id?: string }) => {
    const collection = row.pick_list_id ? byPick.get(row.pick_list_id) || null : null;
    const order = row.pick_list_id ? byOrder.get(row.pick_list_id) : undefined;
    const full = row as Record<string, any>;
    const requestPhotos = (order?.request_photos as unknown[]) || [];
    const photoKinds = [...((full.photos || []) as { kind?: string }[]).map((photo) => photo.kind || 'item'), ...requestPhotos.map(() => 'item')];
    return {
      ...row,
      collection,
      order_number: order?.pick_list_number || null,
      request_lines: order?.request_lines || [],
      request_photos: requestPhotos,
      fault_hint: full.fault ? null : suggestFault({ reason: full.return_reason, courier_problem: full.courier_problem, notes: full.notes }),
      evidence: evidenceChecklist({ photoKinds, reportedAt: full.damage_reported_at, tracking: full.tracking_number || collection?.waybill, fault: full.fault }),
      kind: returnKind(row as Parameters<typeof returnKind>[0]),
      progress: returnProgress(row as { desk_status?: string; how_back?: string; outcome?: string }, collection, today),
    };
  });
  res.json({ returns, reasons: RETURN_REASONS, steps: RETURN_STEPS, faults: FAULTS, photo_kinds: PHOTO_KINDS, claim_statuses: CLAIM_STATUSES });
});

router.post('/', async (req: AuthRequest, res: Response) => {
  const { pick_list_id, lines = [], reason, how_back = 'post', courier_problem, tracking } = req.body || {};
  if (!pick_list_id || !Array.isArray(lines) || !lines.length || !reason) {
    return res.status(400).json({ error: 'Choose an order, at least one line, and a reason' });
  }
  if (!(RETURN_REASONS as readonly string[]).includes(String(reason))) {
    return res.status(400).json({ error: 'Choose a reason from the list' });
  }
  const order = await query(`SELECT id, medusa_order_id, customer_name, customer_email FROM pick_lists WHERE id = $1`, [pick_list_id]);
  if (!order.rows[0]) return res.status(404).json({ error: 'Order not found' });
  const lost = courier_problem === 'lost';
  const desk = lost ? 'claim' : 'due_back';
  const created = await withRmaNumber((number) => query(
    `INSERT INTO return_authorizations
      (rma_number, medusa_order_id, status, redeem_to_warehouse, return_reason, customer_name, customer_email,
       desk_status, how_back, hold_refund, courier_problem, tracking_number, pick_list_id, sold_stock_hold)
     VALUES ($1,$2,'AUTHORIZED', false, $3,$4,$5,$6,$7,$8,$9,$10,$11, true)
     RETURNING *`,
    [number, order.rows[0].medusa_order_id, reason, order.rows[0].customer_name, order.rows[0].customer_email,
      desk, how_back, refundWaitsForInspection({ courierProblem: courier_problem, holdRefund: true }),
      courier_problem || null, tracking || null, pick_list_id]
  ));
  for (const line of lines) {
    // A kit comes back as its parts, so each part is its own line. Parts that are not returning can be taken off afterwards.
    const parts = await splitKitForReturn(String(line.sku), Number(line.qty) || 1);
    for (const part of parts) {
      await query(
        `INSERT INTO return_items (return_authorization_id, product_sku, quantity_requested, item_condition)
         VALUES ($1,$2,$3,$4)`,
        [created.rows[0].id, part.sku, part.qty, parts.length === 1 ? (line.condition || null) : null]
      );
    }
  }
  if (lost || ['bisley_claim', 'carrier_claim'].includes(String(reason))) {
    await query(`INSERT INTO return_claims (return_authorization_id, kind, note) VALUES ($1,$2,$3)`, [
      created.rows[0].id, courier_problem === 'lost' || reason === 'carrier_claim' ? 'carrier' : 'bisley', reason,
    ]);
  }
  res.status(201).json({ return: created.rows[0], sold_stock: soldStockTreatment({ reportSent: false, open: !lost, scannedIn: false }) });
});

router.post('/:id/receive', async (req: AuthRequest, res: Response) => {
  const found = await query(`SELECT desk_status FROM return_authorizations WHERE id = $1`, [req.params.id]);
  const row = found.rows[0];
  if (!row) return res.status(404).json({ error: 'Return not found' });
  if (row.desk_status !== 'due_back') return res.status(400).json({ error: 'This return is not waiting to arrive' });
  await query(`UPDATE return_authorizations SET desk_status = 'to_inspect', updated_at = NOW() WHERE id = $1`, [req.params.id]);
  res.json({ desk_status: 'to_inspect' });
});

router.post('/:id/items/:itemId/photos', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], limit: '8mb' }), async (req: AuthRequest, res: Response) => {
  const bytes = req.body as Buffer;
  const type = String(req.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
  if (!Buffer.isBuffer(bytes) || !bytes.length) return res.status(400).json({ error: 'Choose a photo to upload.' });
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) return res.status(400).json({ error: 'Use a JPEG, PNG, WebP or GIF photo.' });
  const item = await query(`SELECT id FROM return_items WHERE id = $1 AND return_authorization_id = $2`, [req.params.itemId, req.params.id]);
  if (!item.rows[0]) return res.status(404).json({ error: 'Item not found' });
  const saved = await query(
    `INSERT INTO return_desk_photos (return_authorization_id, return_item_id, content_type, image, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [req.params.id, req.params.itemId, type, bytes, req.user?.email || null]
  );
  res.status(201).json({ id: saved.rows[0].id });
});

/** A photo attached to a return request (customer or desk photo), served here so the Returns screen needs no other route. */
router.get('/request-photos/:photoId', async (req: AuthRequest, res: Response) => {
  const found = await query(`SELECT content_type, image FROM return_request_images WHERE id = $1`, [req.params.photoId]);
  const row = found.rows[0];
  if (!row) return res.status(404).json({ error: 'Photo not found' });
  res.setHeader('Content-Type', row.content_type);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.end(row.image);
});

router.get('/photos/:photoId', async (req: AuthRequest, res: Response) => {
  const found = await query(`SELECT content_type, image FROM return_desk_photos WHERE id = $1`, [req.params.photoId]);
  const row = found.rows[0];
  if (!row) return res.status(404).json({ error: 'Photo not found' });
  res.setHeader('Content-Type', row.content_type);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.end(row.image);
});

/** Items on a return, in a fixed order, for working out where the whole return sits. */
async function deskItems(returnId: string) {
  const rows = await query(`SELECT * FROM return_items WHERE return_authorization_id = $1 ORDER BY created_at, id`, [returnId]);
  return rows.rows as { item_condition: string | null; quantity_requested: number | null; quantity_received: number | null; stock_scanned_at: unknown }[];
}

/** The scanned code must be this item's SKU or one of its barcodes. A typed tick is not a scan. */
async function scannedCodeIsItem(code: unknown, sku: string) {
  const typed = String(code ?? '').trim();
  if (!typed) return false;
  const owners = await query(`SELECT product_sku FROM barcode_mappings WHERE barcode = $1 AND is_active = true`, [typed]);
  return codeMatchesItem(typed, sku, owners.rows.map((row: { product_sku: string }) => row.product_sku));
}

router.post('/:id/inspect', async (req: AuthRequest, res: Response) => {
  const { item_id, condition, item_code, bay_scanned, confirm_unopened, photo_note } = req.body || {};
  const found = await query(`SELECT * FROM return_items WHERE id = $1 AND return_authorization_id = $2`, [item_id, req.params.id]);
  const item = found.rows[0];
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const cond = String(condition || '');
  if (!['Unopened', 'Opened', 'Damaged', 'Faulty', 'Wrong item'].includes(cond)) return res.status(400).json({ error: 'Choose the condition of the item' });
  // The scan is checked here, not taken from the screen: the code has to be this item, and the bay has to exist.
  const itemOk = cond === 'Unopened' ? await scannedCodeIsItem(item_code, item.product_sku) : false;
  let bayOk = false;
  if (cond === 'Unopened' && bay_scanned) {
    const bay = await query(`SELECT 1 FROM warehouse_locations WHERE location_code = $1`, [String(bay_scanned).trim()]);
    bayOk = !!bay.rows[0];
  }
  const gate = canScanIntoStock({ condition: cond, itemScanned: itemOk, bayScanned: bayOk, confirmUnopened: !!confirm_unopened });
  await query(
    `UPDATE return_items
     SET item_condition = $2, item_scanned = $3, bay_scanned = $4, unopened_confirmed = $5, item_notes = COALESCE($6, item_notes), updated_at = NOW()
     WHERE id = $1 AND return_authorization_id = $7`,
    [item_id, cond, itemOk, bayOk ? String(bay_scanned).trim() : null, gate.ok, photo_note || null, req.params.id]
  );
  const next = nextDeskStatus(await deskItems(req.params.id));
  await query(`UPDATE return_authorizations SET desk_status = $2, status = 'RECEIVED', received_at = COALESCE(received_at, NOW()), updated_at = NOW() WHERE id = $1`, [req.params.id, next]);
  res.json({
    scan_into_stock: gate.ok,
    reason: 'reason' in gate ? gate.reason : (cond === 'Unopened' ? '' : 'Not going back into stock'),
    item_matched: itemOk,
    bay_found: bayOk,
    desk_status: next,
    decision_changes_stock: decisionChangesStock(),
  });
});

router.post('/:id/scan-in', async (req: AuthRequest, res: Response) => {
  const { item_id } = req.body || {};
  // The movement is recorded against a real user (the column is a user id), as stock-in does.
  const userId = toUuidOrNull(req.user?.id);
  if (!userId) return res.status(400).json({ error: 'A real user login is required to put stock back' });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Lock the line so two scans at once cannot both pass the check.
    const item = await client.query(`SELECT * FROM return_items WHERE id = $1 AND return_authorization_id = $2 FOR UPDATE`, [item_id, req.params.id]);
    const row = item.rows[0];
    if (!row) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Item not found' }); }
    // Only what the inspection verified counts: the item code matched, the bay exists, and it was confirmed unopened.
    const gate = canScanIntoStock({
      condition: row.item_condition,
      itemScanned: row.item_scanned,
      bayScanned: !!row.bay_scanned,
      confirmUnopened: row.unopened_confirmed,
    });
    if (!gate.ok) { await client.query('ROLLBACK'); return res.status(400).json({ error: gate.reason }); }
    const units = scanInUnits(row, 1);
    if (!units.ok) { await client.query('ROLLBACK'); return res.status(409).json({ error: units.reason }); }
    const location = await client.query(`SELECT id FROM warehouse_locations WHERE location_code = $1`, [String(row.bay_scanned).trim()]);
    if (!location.rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Bay not found' }); }
    await client.query(
      `INSERT INTO warehouse_inventory (location_id, product_sku, quantity, liability_status, created_at, updated_at)
       VALUES ($1,$2,$3,'OVARA', NOW(), NOW())
       ON CONFLICT (location_id, product_sku, COALESCE(colour_code, '')) DO UPDATE SET quantity = warehouse_inventory.quantity + $3, liability_status = 'OVARA', updated_at = NOW()`,
      [location.rows[0].id, row.product_sku, units.units]
    );
    await client.query(
      `INSERT INTO warehouse_movements (movement_type, location_id, product_sku, quantity, notes, performed_by)
       VALUES ('return_scan', $1, $2, $3, $4, $5)`,
      [location.rows[0].id, row.product_sku, units.units, `Unopened return ${req.params.id}`, userId]
    );
    await client.query(
      `UPDATE return_items
          SET stock_scanned_at = NOW(), quantity_received = COALESCE(quantity_received, 0) + $2,
              status = CASE WHEN COALESCE(quantity_received, 0) + $2 >= COALESCE(quantity_requested, 1) THEN 'APPROVED' ELSE status END,
              updated_at = NOW()
        WHERE id = $1`,
      [row.id, units.units]
    );
    const all = await client.query(`SELECT * FROM return_items WHERE return_authorization_id = $1 ORDER BY created_at, id`, [req.params.id]);
    const next = nextDeskStatus(all.rows);
    await client.query(
      `UPDATE return_authorizations SET redeem_to_warehouse = true, desk_status = $2, updated_at = NOW() WHERE id = $1`,
      [req.params.id, next]
    );
    await client.query('COMMIT');
    // Returned stock is sellable again: send it to the shop and to any order waiting for it, as stock-in does.
    void stockArrived([row.product_sku]);
    res.json({ stock: '+' + units.units, left_on_line: units.left, desk_status: next, owner: 'Ovara', sold_stock: soldStockTreatment({ reportSent: false, open: false, scannedIn: true }) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('Return scan-in failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'The item was not scanned into stock. Try again.' });
  } finally {
    client.release();
  }
});

/** Apply one decision to one line inside the caller's transaction. Returns what it did to stock. */
async function decideLine(client: import('pg').PoolClient, ra: { id: string }, item: any, decision: string, userId: string | null, email: string | null) {
  const units = unitsToDecide(item);
  const effect = decisionStockEffect(decision);
  if (effect === 'write_off') {
    // The unit never went back into stock, so nothing leaves a bay: the write-off is recorded so it can be counted.
    await client.query(
      `INSERT INTO warehouse_movements (movement_type, location_id, product_sku, quantity, notes, performed_by)
       VALUES ('RETURN_WRITE_OFF', NULL, $1, $2, $3, $4)`,
      [item.product_sku, units, `Written off from return ${ra.id}`, userId]
    );
  } else if (effect === 'held') {
    // Spares and seconds are kept apart from the pick bays, so a damaged unit can never be picked for a customer as new.
    await client.query(
      `INSERT INTO return_held_stock (return_authorization_id, return_item_id, product_sku, units, kind, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ra.id, item.id, item.product_sku, units, decision === 'spares' ? 'spares' : 'second', email]
    );
  } else {
    const kind = decision === 'carrier_claim' ? 'carrier' : 'bisley';
    const have = await client.query(`SELECT 1 FROM return_claims WHERE return_authorization_id = $1 AND kind = $2`, [ra.id, kind]);
    if (!have.rows[0]) await client.query(`INSERT INTO return_claims (return_authorization_id, kind, note) VALUES ($1,$2,$3)`, [ra.id, kind, decision]);
  }
  await client.query(`UPDATE return_items SET decision = $2, decided_at = NOW(), decided_by = $3, updated_at = NOW() WHERE id = $1`, [item.id, decision, email]);
  return { effect, units };
}

router.post('/:id/decide', async (req: AuthRequest, res: Response) => {
  if (!admin(req)) return res.status(403).json({ error: 'Admin approves a write-off, claim, or refund' });
  const decision = String(req.body?.decision || '');
  if (!(ITEM_DECISIONS as readonly string[]).includes(decision)) {
    return res.status(400).json({ error: 'Choose write-off, a Bisley claim, a carrier claim, spare parts, or keep as a second' });
  }
  const userId = toUuidOrNull(req.user?.id);
  const email = req.user?.email || null;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(`SELECT * FROM return_authorizations WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const ra = found.rows[0];
    if (!ra) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Return not found' }); }
    const all = await client.query(`SELECT * FROM return_items WHERE return_authorization_id = $1 ORDER BY created_at, id FOR UPDATE`, [req.params.id]);
    const targets = req.body?.item_id ? all.rows.filter((item: any) => item.id === req.body.item_id) : all.rows.filter((item: any) => !item.decision && unitsToDecide(item) > 0);
    if (req.body?.item_id && !targets.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Item not found' }); }
    if (targets.some((item: any) => item.decision)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'That item already has a decision' }); }
    if (targets.some((item: any) => unitsToDecide(item) <= 0)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Every unit of that item is already back in stock' }) }
    if (targets.length && decisionStockEffect(decision) === 'write_off' && !userId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A real user login is required to record a write-off' });
    }
    let writtenOff = 0;
    let held = 0;
    for (const item of targets) {
      const done = await decideLine(client, ra, item, decision, userId, email);
      if (done.effect === 'write_off') writtenOff += done.units;
      if (done.effect === 'held') held += done.units;
    }
    let next: string;
    if (all.rows.length) {
      const after = await client.query(`SELECT * FROM return_items WHERE return_authorization_id = $1`, [req.params.id]);
      next = deskAfterDecisions(after.rows, !!ra.refunded_at);
    } else {
      // A part refund for damage has no items: the decision is on the return itself.
      if (decision.endsWith('claim')) {
        const kind = decision === 'carrier_claim' ? 'carrier' : 'bisley';
        const have = await client.query(`SELECT 1 FROM return_claims WHERE return_authorization_id = $1 AND kind = $2`, [req.params.id, kind]);
        if (!have.rows[0]) await client.query(`INSERT INTO return_claims (return_authorization_id, kind, note) VALUES ($1,$2,$3)`, [req.params.id, kind, decision]);
      }
      next = decision.endsWith('claim') ? 'claim' : ra.refunded_at ? 'closed' : 'to_refund';
    }
    await client.query(`UPDATE return_authorizations SET decision = $2, desk_status = $3, redeem_to_warehouse = $4, updated_at = NOW() WHERE id = $1`, [req.params.id, decision, next, !!ra.redeem_to_warehouse]);
    await client.query('COMMIT');
    res.json({
      decision,
      desk_status: next,
      stock_change: writtenOff > 0 || held > 0,
      written_off_units: writtenOff,
      held_units: held,
      sold_stock: soldStockTreatment({ reportSent: false, open: false, scannedIn: false }),
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('Return decision failed:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'The decision was not saved. Nothing was changed, so it is safe to try again.' });
  } finally {
    client.release();
  }
});

/** Spares and seconds kept apart from the pick bays, with the return they came from. */
router.get('/held', async (_req: AuthRequest, res: Response) => {
  const rows = await query(
    `SELECT h.id, h.product_sku, h.units, h.kind, h.created_at, h.created_by, ra.rma_number, ra.customer_name
       FROM return_held_stock h JOIN return_authorizations ra ON ra.id = h.return_authorization_id
      WHERE h.released_at IS NULL ORDER BY h.created_at DESC LIMIT 500`
  );
  const totals = await query(`SELECT product_sku, kind, SUM(units)::int AS units FROM return_held_stock WHERE released_at IS NULL GROUP BY 1,2 ORDER BY 1,2`);
  res.json({ held: rows.rows, totals: totals.rows });
});

/** A held spare or second leaves the list when it is used, sold or scrapped. Admin only, once, and the reason is kept. */
router.post('/held/:id/release', async (req: AuthRequest, res: Response) => {
  if (!admin(req)) return res.status(403).json({ error: 'Admin releases held stock' });
  const reason = String(req.body?.reason || '');
  if (!['used', 'sold', 'scrapped'].includes(reason)) return res.status(400).json({ error: 'Say whether it was used, sold or scrapped' });
  const done = await query(
    `UPDATE return_held_stock SET released_at = NOW(), released_by = $2, release_reason = $3 WHERE id = $1 AND released_at IS NULL RETURNING id, product_sku, units, kind`,
    [req.params.id, req.user?.email || null, reason]
  );
  if (!done.rows[0]) return res.status(404).json({ error: 'That held stock was not found or has already been released' });
  res.json({ released: done.rows[0], reason });
});

/** Take a line off a return, for example the parts of a kit that are not coming back. Only before it has been inspected. */
router.delete('/:id/items/:itemId', async (req: AuthRequest, res: Response) => {
  const item = await query(`SELECT * FROM return_items WHERE id = $1 AND return_authorization_id = $2`, [req.params.itemId, req.params.id]);
  const row = item.rows[0];
  if (!row) return res.status(404).json({ error: 'Item not found' });
  if (row.item_condition || Number(row.quantity_received || 0) > 0 || row.decision) {
    return res.status(409).json({ error: 'That item has already been inspected, so it cannot be taken off' });
  }
  await query(`DELETE FROM return_items WHERE id = $1`, [row.id]);
  const left = await deskItems(req.params.id);
  if (!left.length) {
    await query(`UPDATE return_authorizations SET desk_status = 'closed', status = 'CANCELLED', notes = COALESCE(notes, '') || ' Every item was taken off.', updated_at = NOW() WHERE id = $1`, [req.params.id]);
    return res.json({ left: 0, desk_status: 'closed' });
  }
  const current = await query(`SELECT desk_status FROM return_authorizations WHERE id = $1`, [req.params.id]);
  const status = current.rows[0]?.desk_status === 'due_back' ? 'due_back' : nextDeskStatus(left);
  await query(`UPDATE return_authorizations SET desk_status = $2, updated_at = NOW() WHERE id = $1`, [req.params.id, status]);
  res.json({ left: left.length, desk_status: status });
});

router.post('/:id/refund', async (req: AuthRequest, res: Response) => {
  if (!admin(req)) return res.status(403).json({ error: 'Admin approves a refund' });
  const current = await query(`SELECT * FROM return_authorizations WHERE id = $1`, [req.params.id]);
  const row = current.rows[0];
  if (!row) return res.status(404).json({ error: 'Return not found' });
  if (refundWaitsForInspection({ courierProblem: row.courier_problem, holdRefund: row.hold_refund }) && !row.received_at && row.desk_status === 'due_back') {
    return res.status(400).json({ error: 'The refund waits until the item is inspected' });
  }
  if (!row.pick_list_id) return res.status(400).json({ error: 'This return is not linked to a warehouse order, so the shop cannot be refunded from here' });
  const shipping = req.body?.shipping === true;
  const reasonMap: Record<string, string> = { 'Change of mind': 'change_of_mind', Damaged: 'damaged', 'Wrong item': 'wrong_item', Faulty: 'faulty', 'Courier problem': 'lost' };
  try {
    const result = await issueRefund({
      pickListId: row.pick_list_id,
      amount: req.body?.amount,
      reason: req.body?.reason || reasonMap[String(row.return_reason)] || 'other',
      note: req.body?.note || `${row.rma_number}`,
      includesShipping: shipping,
      returnAuthorizationId: row.id,
      idempotencyKey: req.body?.idempotency_key || null,
      actor: String(req.user?.email || 'returns desk'),
    });
    const left = result.position.left;
    await query(
      `UPDATE return_authorizations
       SET status = CASE WHEN $3::numeric <= 0 OR $4::boolean THEN 'REFUNDED' ELSE status END,
           desk_status = CASE WHEN $3::numeric <= 0 OR $4::boolean THEN 'closed' ELSE desk_status END,
           refund_shipping = refund_shipping OR $2, refunded_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [row.id, shipping, left, req.body?.close === true]
    );
    return res.json({ refunded: true, amount: Number(result.refund.amount_gbp), left, payment: 'original', refund: result.refund });
  } catch (error) {
    if (error instanceof RefundError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});

/** Staff set who is at fault. Admin only, because it decides who the business claims against. */
router.post('/:id/fault', async (req: AuthRequest, res: Response) => {
  if (!admin(req)) return res.status(403).json({ error: 'An admin sets who is at fault' });
  const fault = String(req.body?.fault || '');
  if (!isFault(fault)) return res.status(400).json({ error: 'Choose courier, manufacturing, packing, customer or unknown' });
  const note = String(req.body?.note || '').trim().slice(0, 1000) || null;
  const done = await query(
    `UPDATE return_authorizations SET fault = $2, fault_note = $3, fault_by = $4, fault_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING id`,
    [req.params.id, fault, note, req.user?.email || null]
  );
  if (!done.rows[0]) return res.status(404).json({ error: 'Return not found' });
  res.json({ fault, fault_note: note });
});

/** Every photo on a case, for the claim rules: Returns screen photos with their kind, and the request photos (photos of the goods). */
async function casePhotoKinds(returnId: string, pickListId: string | null): Promise<string[]> {
  const own = await query(`SELECT COALESCE(photo_kind, 'item') AS kind FROM return_desk_photos WHERE return_authorization_id = $1`, [returnId]);
  const older = pickListId
    ? await query(`SELECT COUNT(*)::int AS n FROM return_request_images i JOIN return_requests r ON r.id = i.return_request_id WHERE r.pick_list_id = $1 AND r.status <> 'cancelled'`, [pickListId])
    : { rows: [{ n: 0 }] };
  return [...own.rows.map((row: { kind: string }) => row.kind), ...Array.from({ length: Number(older.rows[0]?.n) || 0 }, () => 'item')];
}

/** Raise a claim against the courier or Bisley at any stage. The fault must be set and match, and the usual photo must be there unless a reason is given. */
router.post('/:id/claims', async (req: AuthRequest, res: Response) => {
  if (!admin(req)) return res.status(403).json({ error: 'An admin raises a claim' });
  const kind = String(req.body?.kind || '');
  const found = await query(`SELECT id, fault, desk_status, pick_list_id FROM return_authorizations WHERE id = $1`, [req.params.id]);
  const ra = found.rows[0];
  if (!ra) return res.status(404).json({ error: 'Return not found' });
  const override = String(req.body?.override || '').trim().slice(0, 1000);
  const check = canRaiseClaim({ kind, fault: ra.fault, photoKinds: await casePhotoKinds(ra.id, ra.pick_list_id), override, open: ra.desk_status !== 'closed' });
  if (!check.ok) return res.status(400).json({ error: check.reason });
  if (!isClaimKind(kind)) return res.status(400).json({ error: 'Choose a carrier claim or a Bisley claim.' });
  const open = await query(
    `SELECT id FROM return_claims WHERE return_authorization_id = $1 AND kind = $2 AND COALESCE(status, 'open') NOT IN ('rejected', 'withdrawn')`,
    [ra.id, kind]
  );
  if (open.rows[0]) return res.status(409).json({ error: `A ${kind === 'carrier' ? 'carrier' : 'Bisley'} claim is already on this case.` });
  const note = String(req.body?.note || '').trim().slice(0, 1000) || null;
  const saved = await query(
    `INSERT INTO return_claims (return_authorization_id, kind, note, status, created_by, override_note, updated_at)
     VALUES ($1, $2, $3, 'open', $4, $5, NOW()) RETURNING *`,
    [ra.id, kind, note, req.user?.email || null, override || null]
  );
  res.status(201).json({ claim: saved.rows[0] });
});

/** Move a claim on: sent, accepted, rejected, paid or withdrawn. */
router.post('/claims/:id/status', async (req: AuthRequest, res: Response) => {
  if (!admin(req)) return res.status(403).json({ error: 'An admin updates a claim' });
  const status = String(req.body?.status || '');
  if (!isClaimStatus(status)) return res.status(400).json({ error: 'Choose open, sent, accepted, rejected, paid or withdrawn' });
  const note = String(req.body?.note || '').trim().slice(0, 500);
  const done = await query(
    `UPDATE return_claims SET status = $2, note = CASE WHEN $3 = '' THEN note ELSE left(COALESCE(note || E'\\n', '') || $3, 2000) END, updated_at = NOW() WHERE id = $1 RETURNING id, status`,
    [req.params.id, status, note]
  );
  if (!done.rows[0]) return res.status(404).json({ error: 'Claim not found' });
  res.json(done.rows[0]);
});

/** Add a photo to a case at any stage: the damage, the outer box, the label or the inner packing. */
router.post('/:id/photos', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], limit: '8mb' }), async (req: AuthRequest, res: Response) => {
  const bytes = req.body as Buffer;
  const type = String(req.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
  if (!Buffer.isBuffer(bytes) || !bytes.length) return res.status(400).json({ error: 'Choose a photo to upload.' });
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) return res.status(400).json({ error: 'Use a JPEG, PNG, WebP or GIF photo.' });
  const kind = String(req.query.kind || 'item');
  if (!isPhotoKind(kind)) return res.status(400).json({ error: 'Say what the photo shows: item, box, label, inner or other' });
  const ra = await query(`SELECT id FROM return_authorizations WHERE id = $1`, [req.params.id]);
  if (!ra.rows[0]) return res.status(404).json({ error: 'Return not found' });
  const count = await query(`SELECT COUNT(*)::int AS n FROM return_desk_photos WHERE return_authorization_id = $1`, [req.params.id]);
  if (Number(count.rows[0]?.n) >= 30) return res.status(400).json({ error: 'This case already has 30 photos.' });
  const saved = await query(
    `INSERT INTO return_desk_photos (return_authorization_id, content_type, image, created_by, photo_kind, sku, caption)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [req.params.id, type, bytes, req.user?.email || null, kind, String(req.query.sku || '').trim().slice(0, 120) || null, String(req.query.caption || '').trim().slice(0, 200) || null]
  );
  res.status(201).json({ id: saved.rows[0].id });
});

router.post('/:id/claim-report', async (req: AuthRequest, res: Response) => {
  let found = await query(`SELECT id FROM return_claims WHERE return_authorization_id = $1 ORDER BY created_at DESC LIMIT 1`, [req.params.id]);
  if (!found.rows[0]) {
    found = await query(`INSERT INTO return_claims (return_authorization_id, kind, note) VALUES ($1,'bisley','Claim pack') RETURNING id`, [req.params.id]);
  }
  const pack = await buildClaimPack(found.rows[0].id);
  if (!pack) return res.status(404).json({ error: 'Claim not found' });
  await query(`UPDATE return_claims SET report_name = $2 WHERE id = $1`, [found.rows[0].id, pack.file]);
  res.json({ file: pack.file, link: `/api/returns/desk/claims/${found.rows[0].id}/report`, bytes: pack.zip.length, photos: pack.photos, photos_left_out: pack.skipped, delivered: 'link', target: pack.kind === 'carrier' ? 'carrier' : 'Bisley' });
});

router.post('/claims/:id/report', async (req: AuthRequest, res: Response) => {
  const pack = await buildClaimPack(req.params.id);
  if (!pack) return res.status(404).json({ error: 'Claim not found' });
  await query(`UPDATE return_claims SET report_name = $2 WHERE id = $1`, [req.params.id, pack.file]);
  const link = `/api/returns/desk/claims/${req.params.id}/report`;
  if (isStaging()) {
    await query(
      `INSERT INTO wms_error_log (source, message, context, created_at) VALUES ('returns', $1, $2::jsonb, NOW())`,
      [`Claim pack for ${pack.target} is ready as a link. Staging does not post it to the live carrier or to Bisley.`, JSON.stringify({ claim_id: req.params.id, link })]
    ).catch(() => undefined);
  }
  res.json({ file: pack.file, link, bytes: pack.zip.length, photos: pack.photos, photos_left_out: pack.skipped, delivered: 'link', target: pack.target });
});

router.get('/claims/:id/report', async (req: AuthRequest, res: Response) => {
  const pack = await buildClaimPack(req.params.id);
  if (!pack) return res.status(404).json({ error: 'Claim not found' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${pack.file}"`);
  res.send(pack.zip);
});

export default router;
