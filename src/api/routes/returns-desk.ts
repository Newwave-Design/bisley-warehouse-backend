/**
 * Returns desk from the 19 Nov 2026 design.
 * Stock increases only after an unopened item is scanned, the bay is scanned, and Confirm unopened is ticked.
 * A decision does not change stock. Refunds go to the shop when it is configured; otherwise the failure is logged.
 * A claim pack is a zip the desk can download. Staging does not post it to a live carrier.
 */
import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { isStaging } from '../../lib/staging.js';
import { canScanIntoStock, claimFileName, decisionChangesStock, refundWaitsForInspection, soldStockTreatment, zipStore, RETURN_REASONS } from '../../lib/returns-desk-rules.js';

const router = express.Router();
router.use(authMiddleware);

function admin(req: AuthRequest) {
  return String(req.user?.role || '').toUpperCase() === 'ADMIN' || String(req.user?.role || '').toUpperCase() === 'MANAGER';
}

async function rmaNumber() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const count = await query(`SELECT COUNT(*)::int AS n FROM return_authorizations WHERE rma_number LIKE $1`, [`RMA-${today}-%`]);
  return `RMA-${today}-${String(Number(count.rows[0].n) + 1).padStart(4, '0')}`;
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
      ? `ra.desk_status = 'claim'`
      : `COALESCE(ra.desk_status, 'due_back') <> 'closed'`;
  const rows = await query(
    `SELECT ra.*, COALESCE(json_agg(ri.*) FILTER (WHERE ri.id IS NOT NULL), '[]') AS items,
            COALESCE((
              SELECT json_agg(json_build_object('id', p.id, 'item_id', p.return_item_id) ORDER BY p.created_at)
                FROM return_desk_photos p WHERE p.return_authorization_id = ra.id
            ), '[]') AS photos
     FROM return_authorizations ra
     LEFT JOIN return_items ri ON ri.return_authorization_id = ra.id
     WHERE ${where}
     GROUP BY ra.id
     ORDER BY ra.created_at DESC
     LIMIT 200`
  );
  res.json({ returns: rows.rows, reasons: RETURN_REASONS });
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
  const number = await rmaNumber();
  const created = await query(
    `INSERT INTO return_authorizations
      (rma_number, medusa_order_id, status, redeem_to_warehouse, return_reason, customer_name, customer_email,
       desk_status, how_back, hold_refund, courier_problem, tracking_number, pick_list_id, sold_stock_hold)
     VALUES ($1,$2,'AUTHORIZED', false, $3,$4,$5,$6,$7,$8,$9,$10,$11, true)
     RETURNING *`,
    [number, order.rows[0].medusa_order_id, reason, order.rows[0].customer_name, order.rows[0].customer_email,
      desk, how_back, refundWaitsForInspection({ courierProblem: courier_problem, holdRefund: true }),
      courier_problem || null, tracking || null, pick_list_id]
  );
  for (const line of lines) {
    await query(
      `INSERT INTO return_items (return_authorization_id, product_sku, quantity_requested, item_condition)
       VALUES ($1,$2,$3,$4)`,
      [created.rows[0].id, line.sku, Number(line.qty) || 1, line.condition || null]
    );
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

router.get('/photos/:photoId', async (req: AuthRequest, res: Response) => {
  const found = await query(`SELECT content_type, image FROM return_desk_photos WHERE id = $1`, [req.params.photoId]);
  const row = found.rows[0];
  if (!row) return res.status(404).json({ error: 'Photo not found' });
  res.setHeader('Content-Type', row.content_type);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.end(row.image);
});

router.post('/:id/inspect', async (req: AuthRequest, res: Response) => {
  const { item_id, condition, item_scanned, bay_scanned, confirm_unopened, photo_note } = req.body || {};
  const gate = canScanIntoStock({
    condition: String(condition || ''),
    itemScanned: !!item_scanned,
    bayScanned: !!bay_scanned,
    confirmUnopened: !!confirm_unopened,
  });
  await query(
    `UPDATE return_items
     SET item_condition = $2, item_scanned = $3, bay_scanned = $4, unopened_confirmed = $5, item_notes = COALESCE($6, item_notes), updated_at = NOW()
     WHERE id = $1 AND return_authorization_id = $7`,
    [item_id, condition, !!item_scanned, bay_scanned || null, !!confirm_unopened, photo_note || null, req.params.id]
  );
  const next = gate.ok ? 'to_decide' : condition === 'Unopened' ? 'to_inspect' : 'to_decide';
  await query(`UPDATE return_authorizations SET desk_status = $2, status = 'RECEIVED', received_at = COALESCE(received_at, NOW()), updated_at = NOW() WHERE id = $1`, [req.params.id, next]);
  res.json({ scan_into_stock: gate.ok, reason: 'reason' in gate ? gate.reason : '', decision_changes_stock: decisionChangesStock() });
});

router.post('/:id/scan-in', async (req: AuthRequest, res: Response) => {
  const { item_id, bay } = req.body || {};
  const item = await query(`SELECT * FROM return_items WHERE id = $1 AND return_authorization_id = $2`, [item_id, req.params.id]);
  const row = item.rows[0];
  if (!row) return res.status(404).json({ error: 'Item not found' });
  const gate = canScanIntoStock({
    condition: row.item_condition,
    itemScanned: row.item_scanned,
    bayScanned: !!row.bay_scanned || !!bay,
    confirmUnopened: row.unopened_confirmed,
  });
  if (!gate.ok) return res.status(400).json({ error: gate.reason });
  const location = await query(`SELECT id FROM warehouse_locations WHERE location_code = $1`, [row.bay_scanned || bay]);
  if (!location.rows[0]) return res.status(400).json({ error: 'Bay not found' });
  await query(
    `INSERT INTO warehouse_inventory (location_id, product_sku, quantity, liability_status, created_at, updated_at)
     VALUES ($1,$2,1,'OVARA', NOW(), NOW())
     ON CONFLICT (location_id, product_sku, COALESCE(colour_code, '')) DO UPDATE SET quantity = warehouse_inventory.quantity + 1, liability_status = 'OVARA', updated_at = NOW()`,
    [location.rows[0].id, row.product_sku]
  );
  await query(
    `INSERT INTO warehouse_movements (movement_type, location_id, product_sku, quantity, notes, performed_by)
     VALUES ('return_scan', $1, $2, 1, $3, $4)`,
    [location.rows[0].id, row.product_sku, `Unopened return ${req.params.id}`, req.user?.email || null]
  );
  await query(`UPDATE return_items SET stock_scanned_at = NOW(), quantity_received = 1, status = 'APPROVED', updated_at = NOW() WHERE id = $1`, [row.id]);
  await query(`UPDATE return_authorizations SET redeem_to_warehouse = true, desk_status = 'to_refund', updated_at = NOW() WHERE id = $1`, [req.params.id]);
  res.json({ stock: '+1', owner: 'Ovara', sold_stock: soldStockTreatment({ reportSent: false, open: false, scannedIn: true }) });
});

router.post('/:id/decide', async (req: AuthRequest, res: Response) => {
  if (!admin(req)) return res.status(403).json({ error: 'Admin approves a write-off, claim, or refund' });
  const decision = String(req.body?.decision || '');
  if (!['write_off', 'bisley_claim', 'carrier_claim', 'spares', 'second'].includes(decision)) {
    return res.status(400).json({ error: 'Choose write-off, a Bisley claim, a carrier claim, spare parts, or keep as a second' });
  }
  await query(`UPDATE return_authorizations SET decision = $2, desk_status = $3, redeem_to_warehouse = false, updated_at = NOW() WHERE id = $1`, [
    req.params.id, decision, decision.endsWith('claim') ? 'claim' : 'to_refund',
  ]);
  if (decision.endsWith('claim')) {
    await query(`INSERT INTO return_claims (return_authorization_id, kind, note) VALUES ($1,$2,$3)`, [
      req.params.id, decision === 'carrier_claim' ? 'carrier' : 'bisley', decision,
    ]);
  }
  res.json({ decision, stock_change: decisionChangesStock(), sold_stock: soldStockTreatment({ reportSent: false, open: false, scannedIn: false }) });
});

router.post('/:id/refund', async (req: AuthRequest, res: Response) => {
  if (!admin(req)) return res.status(403).json({ error: 'Admin approves a refund' });
  const current = await query(`SELECT * FROM return_authorizations WHERE id = $1`, [req.params.id]);
  const row = current.rows[0];
  if (!row) return res.status(404).json({ error: 'Return not found' });
  if (refundWaitsForInspection({ courierProblem: row.courier_problem, holdRefund: row.hold_refund }) && !row.received_at && row.desk_status === 'due_back') {
    return res.status(400).json({ error: 'The refund waits until the item is inspected' });
  }
  const partial = req.body?.partial === true;
  const shipping = req.body?.shipping === true;
  let sent = false;
  let shopError = '';
  if (isStaging() || !process.env.MEDUSA_BACKEND_URL) {
    shopError = 'The shop refund was not sent. Staging does not call the live shop.';
    await query(
      `INSERT INTO wms_error_log (source, message, context, created_at)
       VALUES ('returns', $1, $2::jsonb, NOW())`,
      [shopError, JSON.stringify({ return_id: row.id, partial, shipping })]
    ).catch(() => undefined);
  } else {
    shopError = 'The shop refund call is not connected from this desk yet.';
    await query(
      `INSERT INTO wms_error_log (source, message, context, created_at)
       VALUES ('returns', $1, $2::jsonb, NOW())`,
      [shopError, JSON.stringify({ return_id: row.id, partial, shipping })]
    ).catch(() => undefined);
  }
  await query(
    `UPDATE return_authorizations
     SET status = 'REFUNDED', desk_status = 'closed', refund_shipping = $2, refunded_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [row.id, shipping]
  );
  res.json({ refunded: true, sent_to_shop: sent, shop_error: shopError, partial, payment: 'original' });
});

router.post('/:id/claim-report', async (req: AuthRequest, res: Response) => {
  let found = await query(`SELECT id FROM return_claims WHERE return_authorization_id = $1 ORDER BY created_at DESC LIMIT 1`, [req.params.id]);
  if (!found.rows[0]) {
    found = await query(`INSERT INTO return_claims (return_authorization_id, kind, note) VALUES ($1,'bisley','Claim pack') RETURNING id`, [req.params.id]);
  }
  const claim = await query(
    `SELECT c.*, ra.rma_number, ra.customer_name, ra.return_reason, ra.tracking_number
     FROM return_claims c JOIN return_authorizations ra ON ra.id = c.return_authorization_id
     WHERE c.id = $1`,
    [found.rows[0].id]
  );
  const row = claim.rows[0];
  const kind = row.kind === 'carrier' ? 'carrier' : 'bisley';
  const name = claimFileName(row.rma_number, kind);
  const zip = zipStore('claim.txt', [`Return ${row.rma_number}`, row.return_reason || '', row.tracking_number || ''].join('\n'));
  await query(`UPDATE return_claims SET report_name = $2 WHERE id = $1`, [row.id, name]);
  const link = `/api/returns/desk/claims/${row.id}/report`;
  res.json({ file: name, link, bytes: zip.length, delivered: 'link', target: kind === 'carrier' ? 'carrier' : 'Bisley' });
});

router.post('/claims/:id/report', async (req: AuthRequest, res: Response) => {
  const claim = await query(
    `SELECT c.*, ra.rma_number, ra.customer_name, ra.return_reason, ra.tracking_number
     FROM return_claims c JOIN return_authorizations ra ON ra.id = c.return_authorization_id
     WHERE c.id = $1`,
    [req.params.id]
  );
  const row = claim.rows[0];
  if (!row) return res.status(404).json({ error: 'Claim not found' });
  const kind = row.kind === 'carrier' ? 'carrier' : 'bisley';
  const name = claimFileName(row.rma_number, kind);
  const body = [`Return ${row.rma_number}`, `Customer ${row.customer_name || ''}`, `Reason ${row.return_reason || ''}`, `Tracking ${row.tracking_number || ''}`, `Kind ${kind}`].join('\n');
  const zip = zipStore('claim.txt', body);
  await query(`UPDATE return_claims SET report_name = $2 WHERE id = $1`, [row.id, name]);
  const target = kind === 'carrier' ? 'DX UAT or the carrier named on the order' : 'Bisley';
  const link = `/api/returns/desk/claims/${row.id}/report`;
  if (isStaging()) {
    await query(
      `INSERT INTO wms_error_log (source, message, context, created_at) VALUES ('returns', $1, $2::jsonb, NOW())`,
      [`Claim pack for ${target} is ready as a link. Staging does not post it to the live carrier or to Bisley.`, JSON.stringify({ claim_id: row.id, link })]
    ).catch(() => undefined);
  }
  res.json({ file: name, link, bytes: zip.length, delivered: 'link', target });
});

router.get('/claims/:id/report', async (req: AuthRequest, res: Response) => {
  const claim = await query(
    `SELECT c.kind, c.report_name, ra.rma_number, ra.customer_name, ra.return_reason, ra.tracking_number
     FROM return_claims c JOIN return_authorizations ra ON ra.id = c.return_authorization_id WHERE c.id = $1`,
    [req.params.id]
  );
  const row = claim.rows[0];
  if (!row) return res.status(404).json({ error: 'Claim not found' });
  const kind = row.kind === 'carrier' ? 'carrier' : 'bisley';
  const name = row.report_name || claimFileName(row.rma_number, kind);
  const zip = zipStore('claim.txt', `Return ${row.rma_number}\n${row.return_reason || ''}\n${row.tracking_number || ''}`);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(zip);
});

export default router;
