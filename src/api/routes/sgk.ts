/**
 * SGK Distribution queue.
 * Booking an order with courier SGK (POST /api/apc/book) queues it. This route lists the queue as consignments,
 * exports it in SGK's upload layout (CSV or XLSX), keeps the driver notes, and marks consignments sent once SGK has them.
 */

import express, { Response } from 'express';
import * as XLSX from 'xlsx';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { query } from '../../db/index.js';
import { actorName, shipBookedPickList } from '../../lib/pick-list-events.js';
import { fulfillPickListInMedusa } from '../../lib/medusa-fulfillment.js';
import { takeStockForBookedCollection } from '../../lib/collection-stock.js';
import { shipCollectionsDueToday } from '../../lib/ship-todays-collections.js';
import { packagingText, packToUse, sgkCartonLabels, type CartonPackaging, type PackOption } from '../../lib/sgk-label.js';
import { attachPackaging } from '../../lib/pick-list-packaging.js';
import { SGK_COLUMNS, sgkCsv, sgkItems, sgkRows, shopOrderNumber, sgkOrderNo, type SgkPiece, type SgkRow } from '../../lib/sgk.js';

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id || '').trim()).filter((id) => UUID.test(id)))];
}

type Consignment = {
  key: string;
  pickListId: string;
  pickListNumber: string;
  orderNumber: string;
  orderNo: string;
  orderDate: string | null;
  customerName: string;
  email: string;
  phone: string;
  address: Record<string, unknown>;
  postcode: string;
  driverNotes: string;
  bookingIds: string[];
  pieces: SgkPiece[];
  items: { code: string; desc: string; qty: number; weightKg: string; thumbnail?: string | null }[];
  queuedAt: string | null;
  sentAt: string | null;
  collectionDate: string | null;
};

/** Every SGK booking that is not cancelled, one consignment per order and sent state. */
async function loadConsignments(filter: { view?: string; pickListIds?: string[] } = {}): Promise<Consignment[]> {
  const params: unknown[] = [];
  const where = [`cb.courier = 'SGK'`, `cb.status <> 'cancelled'`, `COALESCE(cb.direction, 'outbound') <> 'return'`];
  if (filter.view === 'sent') where.push('cb.sent_at IS NOT NULL');
  else if (filter.view !== 'all') where.push('cb.sent_at IS NULL');
  if (filter.pickListIds?.length) {
    params.push(filter.pickListIds);
    where.push(`cb.pick_list_id = ANY($${params.length}::uuid[])`);
  }
  const result = await query(
    `SELECT cb.id, cb.pick_list_id, cb.apc_order_number AS batch, cb.pieces, cb.driver_notes, cb.created_at, cb.sent_at, cb.collection_date,
            pl.pick_list_number, pl.customer_name, pl.customer_email, pl.shipping_address,
            COALESCE((SELECT parent.created_at FROM pick_lists parent WHERE parent.id = pl.parent_pick_list_id), pl.created_at) AS order_date
       FROM collection_bookings cb
       JOIN pick_lists pl ON pl.id = cb.pick_list_id
      WHERE ${where.join(' AND ')}
      ORDER BY cb.created_at, cb.id`,
    params,
  );
  const groups = new Map<string, Consignment>();
  const seenBatch = new Set<string>();
  for (const row of result.rows as any[]) {
    const key = `${row.pick_list_id}:${row.sent_at ? 'sent' : 'queued'}`;
    let group = groups.get(key);
    const address = (row.shipping_address && typeof row.shipping_address === 'object' ? row.shipping_address : {}) as Record<string, unknown>;
    if (!group) {
      group = {
        key,
        pickListId: row.pick_list_id,
        pickListNumber: row.pick_list_number || '',
        orderNumber: shopOrderNumber(row.pick_list_number || ''),
        orderNo: sgkOrderNo(row.pick_list_number || ''),
        orderDate: row.order_date ? new Date(row.order_date).toISOString() : null,
        customerName: row.customer_name || '',
        email: row.customer_email || '',
        phone: String(address.phone || ''),
        address,
        postcode: String(address.postal_code || '').toUpperCase(),
        driverNotes: '',
        bookingIds: [],
        pieces: [],
        items: [],
        queuedAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
        collectionDate: row.collection_date || null,
      };
      groups.set(key, group);
    }
    group.bookingIds.push(row.id);
    if (row.driver_notes && !group.driverNotes) group.driverNotes = row.driver_notes;
    // A queued order has a booking row for each item and every row carries the same boxes, so each batch counts once.
    const batchKey = `${key}:${row.batch || row.id}`;
    if (!seenBatch.has(batchKey)) {
      seenBatch.add(batchKey);
      const pieces = Array.isArray(row.pieces) ? row.pieces : [];
      group.pieces.push(...pieces.map((piece: any) => ({ sku: piece?.sku, itemSku: piece?.itemSku, title: piece?.title, reference: piece?.reference, weightKg: piece?.weightKg })));
    }
  }
  const list = [...groups.values()];
  // The shop title of the line is a better description for SGK than the carton name the desk planned.
  const titles = new Map<string, string>();
  if (list.length) {
    const lines = await query(
      `SELECT pick_list_id, product_sku, item_title FROM pick_list_items
        WHERE pick_list_id = ANY($1::uuid[]) AND COALESCE(item_title, '') <> ''`,
      [[...new Set(list.map((group) => group.pickListId))]],
    );
    for (const line of lines.rows as { pick_list_id: string; product_sku: string; item_title: string }[]) {
      titles.set(`${line.pick_list_id}:${line.product_sku}`, line.item_title);
    }
  }
  // A picture of each product, as the pick lists show.
  const pictures = new Map<string, string>();
  const codes = [...new Set(list.flatMap((group) => group.pieces.map((piece) => String(piece.itemSku || piece.sku || '').trim().toUpperCase()).filter(Boolean)))];
  if (codes.length) {
    const found = await query(
      `SELECT upper(variant_sku) AS sku, variant_thumbnail FROM wms_products WHERE upper(variant_sku) = ANY($1::text[]) AND COALESCE(variant_thumbnail, '') <> ''`,
      [codes],
    ).catch(() => ({ rows: [] as { sku: string; variant_thumbnail: string }[] }));
    for (const row of found.rows as { sku: string; variant_thumbnail: string }[]) pictures.set(row.sku, row.variant_thumbnail);
  }
  for (const group of list) {
    group.items = sgkItems(group.pieces).map((item) => ({ ...item, desc: titles.get(`${group.pickListId}:${item.code}`) || item.desc, thumbnail: pictures.get(item.code.toUpperCase()) || null }));
    group.pieces = sgkPiecesWithTitles(group.pieces, titles, group.pickListId);
  }
  return list;
}

/** GET /api/sgk/queue?view=queued|sent|all */
router.get('/queue', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const view = String(req.query.view || 'queued');
    const consignments = await loadConsignments({ view });
    return res.json({ consignments: consignments.map((consignment) => ({ ...consignment, rows: exportRows([consignment]) })), columns: SGK_COLUMNS });
  } catch (error) {
    console.error('SGK queue failed', error instanceof Error ? error.message : 'query failed');
    return res.status(500).json({ error: 'Could not load the SGK queue' });
  }
});

/** GET /api/sgk/count: how many consignments are waiting to go to SGK. */
router.get('/count', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT COUNT(DISTINCT pick_list_id)::int AS waiting
         FROM collection_bookings
        WHERE courier = 'SGK' AND status <> 'cancelled' AND sent_at IS NULL AND COALESCE(direction, 'outbound') <> 'return'`,
    );
    return res.json({ waiting: result.rows[0]?.waiting ?? 0 });
  } catch (error) {
    console.error('SGK count failed', error instanceof Error ? error.message : 'query failed');
    return res.status(500).json({ error: 'Could not count the SGK queue' });
  }
});

/** PATCH /api/sgk/driver-notes: { pickListId, driverNotes }. Only for orders still in the queue. */
router.patch('/driver-notes', authMiddleware, async (req: AuthRequest, res: Response) => {
  const pickListId = String(req.body?.pickListId || '').trim();
  if (!UUID.test(pickListId)) return res.status(400).json({ error: 'Choose an order' });
  const notes = String(req.body?.driverNotes ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim().slice(0, 500);
  try {
    const updated = await query(
      `UPDATE collection_bookings SET driver_notes = $2, updated_at = NOW()
        WHERE pick_list_id = $1 AND courier = 'SGK' AND status <> 'cancelled' AND sent_at IS NULL
        RETURNING id`,
      [pickListId, notes || null],
    );
    if (!updated.rows.length) return res.status(404).json({ error: 'That order is not in the SGK queue' });
    return res.json({ saved: true, driverNotes: notes });
  } catch (error) {
    console.error('SGK driver notes failed', error instanceof Error ? error.message : 'query failed');
    return res.status(500).json({ error: 'Could not save the driver notes' });
  }
});

function sgkPiecesWithTitles(pieces: SgkPiece[], titles: Map<string, string>, pickListId: string): SgkPiece[] {
  return pieces.map((piece) => {
    const code = String(piece.itemSku || piece.sku || '').trim();
    const title = titles.get(`${pickListId}:${code}`);
    return title ? { ...piece, title } : piece;
  });
}

/**
 * For each SKU, the packaging to write on its label: every active option for the SKU (or its longest matching product
 * code), with shelf stock, then the first one that is all in stock. Products with only a method (own box) use that.
 */
async function packagingInStock(skus: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(skus.filter(Boolean).map((sku) => sku.toUpperCase()))];
  const out = new Map<string, string>();
  if (!wanted.length) return out;
  const rows = (await query(
    `SELECT upper(b.sku) AS sku, upper(b.product_code) AS product_code, b.option_rank AS rank, b.method,
            COALESCE(json_agg(json_build_object('code', i.code, 'name', i.name, 'item_type', i.item_type, 'stock_on_hand', i.stock_on_hand))
              FILTER (WHERE i.id IS NOT NULL), '[]') AS items
       FROM packaging_boms b
       LEFT JOIN packaging_bom_lines l ON l.bom_id = b.id
       LEFT JOIN packaging_items i ON i.id = l.packaging_item_id
      WHERE b.is_active
      GROUP BY b.id`,
  )).rows as { sku: string | null; product_code: string | null; rank: number; method: string | null; items: PackOption['items'] }[];
  const methods = (await query(`SELECT upper(product_code) AS code, method FROM packaging_product_specs WHERE is_active`)).rows as { code: string; method: string }[];
  for (const sku of wanted) {
    let options = rows.filter((row) => row.sku === sku);
    if (!options.length) {
      const codes = rows.filter((row) => !row.sku && row.product_code && (sku === row.product_code || sku.startsWith(`${row.product_code}-`)));
      const longest = Math.max(0, ...codes.map((row) => (row.product_code || '').length));
      options = codes.filter((row) => (row.product_code || '').length === longest);
    }
    const chosen = packToUse(options.map((row) => ({ rank: Number(row.rank) || 1, method: row.method, items: row.items })));
    let text = chosen ? packagingText(chosen) : '';
    if (!text) {
      const spec = methods.filter((row) => sku === row.code || sku.startsWith(`${row.code}-`)).sort((a, b) => b.code.length - a.code.length)[0];
      text = packagingText({ method: spec?.method || null, items: [] });
    }
    out.set(sku, text);
  }
  return out;
}

/** One ZPL label per carton for the order this booking belongs to: order number, customer, address and 1/N. */
export async function sgkLabelsForBooking(bookingId: string): Promise<{ trackingNumber: string; format: string; content: string }[]> {
  const found = await query(`SELECT pick_list_id FROM collection_bookings WHERE id = $1 AND courier = 'SGK' AND status <> 'cancelled'`, [bookingId]);
  const pickListId = found.rows[0]?.pick_list_id as string | undefined;
  if (!pickListId) return [];
  const group = (await loadConsignments({ view: 'all', pickListIds: [pickListId] })).find((entry) => entry.bookingIds.includes(bookingId));
  if (!group || !group.pieces.length) return [];
  const address = group.address as Record<string, string>;
  const person = `${address.first_name || ''} ${address.last_name || ''}`.trim() || group.customerName;
  const lines = [address.company && address.company !== person ? address.company : '', address.address_1, address.address_2, [address.city, address.province].filter(Boolean).join(', ')].filter(Boolean);
  // The box, or sleeve and tray, each carton's product goes in: the first choice, or the option on the shelf when it is out
  const skus = group.pieces.map((piece) => String(piece.itemSku || piece.sku || '').trim());
  const packBySku = await packagingInStock(skus).catch(async () => {
    const packed = (await attachPackaging([skus.filter(Boolean).map((sku) => ({ sku, quantity_required: 1 }))]).catch(() => [[]]))[0] as { sku: string; packaging?: CartonPackaging }[];
    return new Map(packed.map((row) => [row.sku.toUpperCase(), packagingText(row.packaging)]));
  });
  const jobs = sgkCartonLabels({
    orderNo: group.orderNo,
    shopNumber: group.orderNumber,
    name: person,
    lines,
    postcode: group.postcode,
    driverNotes: group.driverNotes,
    cartons: group.pieces.map((piece, index) => ({ title: String(piece.title || ''), sku: skus[index], pack: packBySku.get(skus[index].toUpperCase()) || '' })),
  });
  return jobs.map((job, index) => ({ trackingNumber: `${group.orderNo}-${index + 1}`, format: 'ZPL', content: Buffer.from(job, 'latin1').toString('base64') }));
}

function exportRows(consignments: Consignment[]): SgkRow[] {
  return consignments.flatMap((consignment) => sgkRows({
    pickListNumber: consignment.pickListNumber,
    orderDate: consignment.orderDate,
    customerName: consignment.customerName,
    email: consignment.email,
    phone: consignment.phone,
    shippingAddress: consignment.address,
    driverNotes: consignment.driverNotes,
    pieces: consignment.pieces,
  }));
}

function stamp(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts;
}

/**
 * POST /api/sgk/export: { pickListIds?: string[], format?: 'csv' | 'xlsx', view?: 'queued' | 'sent' }.
 * Nothing is marked sent here, so an export can be repeated. Without ids the whole queue is exported.
 */
router.post('/export', authMiddleware, async (req: AuthRequest, res: Response) => {
  const pickListIds = ids(req.body?.pickListIds);
  const format = String(req.body?.format || 'csv').toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
  const view = String(req.body?.view || 'queued') === 'sent' ? 'sent' : 'queued';
  try {
    const consignments = await loadConsignments({ view, pickListIds });
    if (!consignments.length) return res.status(404).json({ error: 'Nothing in the SGK queue to export' });
    const rows = exportRows(consignments);
    const missing = consignments.filter((consignment) => !consignment.orderNo);
    if (missing.length) return res.status(409).json({ error: `Order ${missing[0].customerName || missing[0].pickListNumber} has no order number SGK can use` });
    const name = `SGK-orders-${stamp()}`;
    if (format === 'xlsx') {
      // Text cells, so a phone number keeps its leading zero.
      const sheet = XLSX.utils.aoa_to_sheet([[...SGK_COLUMNS], ...rows.map((row) => SGK_COLUMNS.map((column) => row[column] ?? ''))]);
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, 'Sheet1');
      const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
      return res.send(buffer);
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    return res.send(sgkCsv(rows));
  } catch (error) {
    console.error('SGK export failed', error instanceof Error ? error.message : 'query failed');
    return res.status(500).json({ error: 'Could not build the SGK export' });
  }
});

/**
 * POST /api/sgk/remove: { pickListIds }. Takes orders out of the SGK queue, so they can be queued again or sent another way.
 * Only orders SGK has not collected. Nothing had shipped or left stock while they were queued, so nothing is put back.
 */
router.post('/remove', authMiddleware, async (req: AuthRequest, res: Response) => {
  const pickListIds = ids(req.body?.pickListIds);
  if (!pickListIds.length) return res.status(400).json({ error: 'Choose at least one order' });
  try {
    const updated = await query(
      `UPDATE collection_bookings SET status = 'cancelled', updated_at = NOW()
        WHERE pick_list_id = ANY($1::uuid[]) AND courier = 'SGK' AND status <> 'cancelled' AND sent_at IS NULL
          AND COALESCE(direction, 'outbound') <> 'return'
        RETURNING pick_list_id`,
      [pickListIds],
    );
    const done = [...new Set((updated.rows as { pick_list_id: string }[]).map((row) => row.pick_list_id))];
    return res.json({ removed: done.length, pickListIds: done });
  } catch (error) {
    console.error('SGK remove failed', error instanceof Error ? error.message : 'query failed');
    return res.status(500).json({ error: 'Could not remove the orders from the SGK queue' });
  }
});

/**
 * POST /api/sgk/mark-sent: { pickListIds, collectionDate? }.
 * SGK has the orders, so each one ships the way a booked APC or DX collection does: the order moves to Shipped,
 * the picked stock leaves the warehouse, and the shop order is fulfilled.
 */
router.post('/mark-sent', authMiddleware, async (req: AuthRequest, res: Response) => {
  const pickListIds = ids(req.body?.pickListIds);
  if (!pickListIds.length) return res.status(400).json({ error: 'Choose at least one order' });
  const date = String(req.body?.collectionDate || '').trim();
  const collectionDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : stamp();
  try {
    const updated = await query(
      `UPDATE collection_bookings
          SET sent_at = NOW(), collection_date = $2, updated_at = NOW()
        WHERE pick_list_id = ANY($1::uuid[]) AND courier = 'SGK' AND status <> 'cancelled' AND sent_at IS NULL
          AND COALESCE(direction, 'outbound') <> 'return'
        RETURNING pick_list_id`,
      [pickListIds, collectionDate],
    );
    const done = [...new Set((updated.rows as { pick_list_id: string }[]).map((row) => row.pick_list_id))];
    res.json({ sent: done.length, pickListIds: done });
    const actor = actorName(req.user);
    const userId = String(req.user?.id || '');
    for (const pickListId of done) {
      await shipBookedPickList(pickListId, actor).catch((error) => console.warn('Marking the SGK order shipped failed', error instanceof Error ? error.message : 'failed'));
      await fulfillPickListInMedusa(pickListId).catch((error) => console.warn('Fulfilling the SGK order failed', error instanceof Error ? error.message : 'failed'));
      await takeStockForBookedCollection(pickListId, userId).catch((error) => console.warn('Removing SGK stock failed', error instanceof Error ? error.message : 'failed'));
    }
    void shipCollectionsDueToday().catch(() => undefined);
  } catch (error) {
    console.error('SGK mark sent failed', error instanceof Error ? error.message : 'query failed');
    if (!res.headersSent) res.status(500).json({ error: 'Could not mark the orders as sent' });
  }
});

export default router;
