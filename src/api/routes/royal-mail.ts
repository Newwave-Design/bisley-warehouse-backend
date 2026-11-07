/**
 * Royal Mail postage for sample orders.
 * Book creates the Click & Drop orders. Send for collection manifests them.
 */

import express, { Response } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { query } from '../../db/index.js';
import { fulfillPickListsInMedusa } from '../../lib/medusa-fulfillment.js';
import { actorName, recordPickListEvents } from '../../lib/pick-list-events.js';
import {
  createRoyalMailOrders,
  deleteRoyalMailOrders,
  fetchRoyalMailLabelPdf,
  manifestRoyalMail,
  RoyalMailError,
  royalMailConfigured,
  royalMailServiceCode,
} from '../../lib/royal-mail.js';

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idsFrom(body: unknown): string[] {
  const raw = (body as { pickListIds?: unknown })?.pickListIds;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((id) => String(id || '').trim()).filter((id) => UUID.test(id)))];
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function addressOf(value: unknown): Record<string, string> {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return addressOf(JSON.parse(value)); } catch { return {}; }
  }
  return value as Record<string, string>;
}

router.post('/book', authMiddleware, async (req: AuthRequest, res: Response) => {
  if (!royalMailConfigured()) {
    return res.status(500).json({ error: 'Royal Mail is not connected. Add the Click & Drop API key.' });
  }
  const ids = idsFrom(req.body);
  if (!ids.length) return res.status(400).json({ error: 'Select at least one sample order' });
  if (ids.length > 100) return res.status(400).json({ error: 'Book at most 100 sample orders at a time' });

  try {
    const found = await query(
      `SELECT pl.id, pl.pick_list_number, pl.customer_name, pl.shipping_address, pl.is_sandbox, pl.status,
              (SELECT COUNT(*)::int FROM pick_list_items pli
                WHERE pli.pick_list_id = pl.id AND NOT pli.is_archived AND pli.product_sku ILIKE '%SAMPLE%') AS sample_count,
              (SELECT COUNT(*)::int FROM pick_list_items pli
                WHERE pli.pick_list_id = pl.id AND NOT pli.is_archived AND pli.product_sku ILIKE '%SAMPLE%' AND pli.status <> 'PICKED') AS samples_open,
              cb.apc_order_number AS royal_mail_order_id
       FROM pick_lists pl
       LEFT JOIN collection_bookings cb
         ON cb.pick_list_id = pl.id AND cb.courier = 'RM' AND cb.status <> 'cancelled'
       WHERE pl.id = ANY($1::uuid[])`,
      [ids],
    );
    const byId = new Map(found.rows.map((row) => [row.id, row]));
    const skipped: { id: string; pick_list_number?: string; reason: string }[] = [];
    const already: { id: string; orderIdentifier: number }[] = [];
    const pending: { id: string; orderReference: string; recipient: any; sampleCount: number; postcode: string; summary: string }[] = [];

    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        skipped.push({ id, reason: 'Unknown order' });
        continue;
      }
      if (row.is_sandbox || row.status === 'CANCELLED') {
        skipped.push({ id, pick_list_number: row.pick_list_number, reason: 'This order cannot be posted' });
        continue;
      }
      if (Number(row.sample_count) < 1) {
        skipped.push({ id, pick_list_number: row.pick_list_number, reason: 'Not a sample order' });
        continue;
      }
      if (Number(row.samples_open) > 0) {
        skipped.push({ id, pick_list_number: row.pick_list_number, reason: 'Mark the colours picked first' });
        continue;
      }
      const existingId = Number(row.royal_mail_order_id);
      if (Number.isFinite(existingId) && existingId > 0) {
        already.push({ id, orderIdentifier: existingId });
        continue;
      }
      const address = addressOf(row.shipping_address);
      const fullName = clean(`${address.first_name || ''} ${address.last_name || ''}`) || clean(row.customer_name);
      const line1 = clean(address.address_1);
      const city = clean(address.city) || clean(address.province);
      const postcode = clean(address.postal_code).toUpperCase();
      const country = (clean(address.country_code) || 'GB').toUpperCase();
      if (!fullName || !line1 || !city || !postcode) {
        skipped.push({ id, pick_list_number: row.pick_list_number, reason: 'The shipping address is incomplete' });
        continue;
      }
      const company = clean(address.company);
      const line2 = clean(address.address_2);
      const county = clean(address.province);
      const phone = clean(address.phone);
      pending.push({
        id,
        orderReference: clean(row.pick_list_number).slice(0, 40),
        sampleCount: Number(row.sample_count) || 1,
        postcode,
        summary: [company, line1, city, postcode].filter(Boolean).join(', '),
        recipient: {
          address: {
            fullName: fullName.slice(0, 210),
            ...(company ? { companyName: company.slice(0, 100) } : {}),
            addressLine1: line1.slice(0, 100),
            ...(line2 ? { addressLine2: line2.slice(0, 100) } : {}),
            city: city.slice(0, 100),
            ...(county ? { county: county.slice(0, 100) } : {}),
            postcode: postcode.slice(0, 20),
            countryCode: country.slice(0, 3),
          },
          ...(phone ? { phoneNumber: phone.slice(0, 25) } : {}),
        },
      });
    }

    let created: { id: string; orderIdentifier: number; trackingNumber: string; postcode: string; summary: string }[] = [];
    const failed: { pick_list_number?: string; reason: string }[] = [];
    if (pending.length) {
      const result = await createRoyalMailOrders(pending.map((row) => ({
        orderReference: row.orderReference,
        recipient: row.recipient,
        sampleCount: row.sampleCount,
      })));
      const pendingByRef = new Map(pending.map((row) => [row.orderReference, row]));
      created = result.created.map((row) => {
        const source = pendingByRef.get(row.orderReference);
        return {
          id: source?.id || '',
          orderIdentifier: row.orderIdentifier,
          trackingNumber: row.trackingNumber,
          postcode: source?.postcode || '',
          summary: source?.summary || '',
        };
      }).filter((row) => row.id);
      for (const row of result.failed) {
        const source = pendingByRef.get(row.orderReference);
        failed.push({ pick_list_number: source?.orderReference, reason: row.reason });
      }
    }

    const service = royalMailServiceCode();
    const saved = [];
    try {
    for (const row of created) {
      const tracking = row.trackingNumber.slice(0, 32);
      const url = tracking.length >= 8
        ? `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(tracking)}`
        : '';
      const inserted = await query(
        `INSERT INTO collection_bookings
           (pick_list_id, sku, courier, service_code, service_name, waybill, apc_order_number,
            collection_postcode, delivery_postcode, delivery_summary, pieces, status)
         VALUES ($1, 'SAMPLE', 'RM', $2, 'Royal Mail', NULLIF($3, ''), $4, 'NP4 0HZ', $5, $6, $7::jsonb, 'booked')
         RETURNING id, pick_list_id, sku, courier, service_code, service_name, waybill,
                   collection_postcode, delivery_postcode, delivery_summary, pieces, status, collection_date`,
        [
          row.id,
          service || null,
          tracking,
          String(row.orderIdentifier),
          row.postcode,
          row.summary,
          JSON.stringify(tracking ? [{ trackingNumber: tracking }] : []),
        ],
      );
      saved.push(inserted.rows[0]);
      if (url) {
        await query(
          `UPDATE pick_lists
              SET tracking_number = CASE WHEN COALESCE(btrim(tracking_number), '') = '' THEN $2 ELSE tracking_number END,
                  tracking_url = CASE WHEN COALESCE(btrim(tracking_url), '') = '' THEN $3 ELSE tracking_url END,
                  carrier = CASE WHEN COALESCE(btrim(carrier), '') = '' THEN 'Royal Mail' ELSE carrier END,
                  updated_at = NOW()
            WHERE id = $1`,
          [row.id, tracking, url],
        );
      }
    }
    } catch (error) {
      const orderIds = created.map((row) => row.orderIdentifier);
      try {
        await deleteRoyalMailOrders(orderIds);
      } catch (cancelError) {
        console.error('Royal Mail cleanup failed', cancelError instanceof Error ? cancelError.message : 'cancel failed');
        return res.status(500).json({ error: 'Royal Mail created the postage, but it could not be saved. Check Click & Drop before booking these orders again.' });
      }
      console.error('Saving Royal Mail booking failed', error instanceof Error ? error.message : 'query failed');
      return res.status(500).json({ error: 'Royal Mail postage could not be saved, so it was cancelled. Book these orders again.' });
    }

    const bookedIds = [...created.map((row) => row.id), ...already.map((row) => row.id)];
    if (bookedIds.length) {
      const ready = await query(
        `SELECT pl.id
         FROM pick_lists pl
         WHERE pl.id = ANY($1::uuid[])
           AND pl.status IN ('PENDING', 'IN_PROGRESS')
           AND NOT EXISTS (
             SELECT 1 FROM pick_list_items pli
             WHERE pli.pick_list_id = pl.id AND NOT pli.is_archived
               AND pli.product_sku ILIKE '%SAMPLE%' AND pli.status <> 'PICKED'
           )`,
        [bookedIds],
      );
      const ids = ready.rows.map((row) => row.id as string);
      if (ids.length) {
        await recordPickListEvents({
          ids,
          actor: actorName(req.user),
          action: 'status',
          summary: 'Collection booked',
          status: 'PICKED',
        });
      }
    }

    const printable = [
      ...created.map((row) => row.orderIdentifier),
      ...already.map((row) => row.orderIdentifier),
    ];
    let pdf: string | null = null;
    let labelError = '';
    if (printable.length) {
      try {
        pdf = (await fetchRoyalMailLabelPdf(printable)).toString('base64');
      } catch (error) {
        labelError = error instanceof Error ? error.message : 'Royal Mail did not return the labels.';
      }
    }

    return res.status(created.length ? 201 : 200).json({
      booked: saved,
      already: already.length,
      skipped: [...skipped, ...failed],
      pdf,
      labelError,
    });
  } catch (error) {
    const message = error instanceof RoyalMailError
      ? error.message
      : 'Could not reach Royal Mail. Nothing new was booked.';
    console.error('Royal Mail booking failed', error instanceof Error ? error.message : 'request failed');
    return res.status(502).json({ error: message });
  }
});

router.post('/labels', authMiddleware, async (req: AuthRequest, res: Response) => {
  if (!royalMailConfigured()) {
    return res.status(500).json({ error: 'Royal Mail is not connected. Add the Click & Drop API key.' });
  }
  const ids = idsFrom(req.body);
  if (!ids.length) return res.status(400).json({ error: 'Select at least one sample order' });
  try {
    const found = await query(
      `SELECT apc_order_number
       FROM collection_bookings
       WHERE pick_list_id = ANY($1::uuid[]) AND courier = 'RM' AND status <> 'cancelled'`,
      [ids],
    );
    const orderIds = found.rows
      .map((row) => Number(row.apc_order_number))
      .filter((id) => Number.isFinite(id) && id > 0);
    if (!orderIds.length) return res.status(404).json({ error: 'None of these orders have Royal Mail postage yet.' });
    const pdf = await fetchRoyalMailLabelPdf(orderIds);
    return res.json({ pdf: pdf.toString('base64') });
  } catch (error) {
    const message = error instanceof RoyalMailError ? error.message : 'Could not print the Royal Mail labels.';
    console.error('Royal Mail labels failed', error instanceof Error ? error.message : 'request failed');
    return res.status(502).json({ error: message });
  }
});

router.post('/manifest', authMiddleware, async (_req: AuthRequest, res: Response) => {
  if (!royalMailConfigured()) {
    return res.status(500).json({ error: 'Royal Mail is not connected. Add the Click & Drop API key.' });
  }
  try {
    const result = await manifestRoyalMail();
    const found = await query(
      `SELECT DISTINCT pl.id
       FROM pick_lists pl
       JOIN collection_bookings cb ON cb.pick_list_id = pl.id AND cb.courier = 'RM' AND cb.status <> 'cancelled'
       WHERE pl.status NOT IN ('DISPATCHED', 'CANCELLED') AND NOT pl.is_archived`,
    );
    const ids = found.rows.map((row) => row.id as string);
    let medusa_sync: { ok: boolean; error?: string }[] = [];
    if (ids.length) {
      await recordPickListEvents({
        ids,
        actor: actorName(_req.user),
        action: 'status',
        summary: 'Shipped',
        status: 'DISPATCHED',
      });
      medusa_sync = await fulfillPickListsInMedusa(ids);
    }
    return res.json({ ...result, shipped: ids.length, shippedIds: ids, medusa_sync });
  } catch (error) {
    const message = error instanceof RoyalMailError ? error.message : 'Could not send the Royal Mail collection.';
    console.error('Royal Mail manifest failed', error instanceof Error ? error.message : 'request failed');
    return res.status(502).json({ error: message });
  }
});

router.post('/cancel', authMiddleware, async (req: AuthRequest, res: Response) => {
  const id = String(req.body?.pickListId || '').trim();
  if (!UUID.test(id)) return res.status(400).json({ error: 'Unknown order' });
  try {
    const found = await query(
      `SELECT id, apc_order_number
       FROM collection_bookings
       WHERE pick_list_id = $1 AND courier = 'RM' AND status <> 'cancelled'`,
      [id],
    );
    const booking = found.rows[0];
    if (!booking) return res.status(404).json({ error: 'This order has no Royal Mail postage.' });
    const orderId = Number(booking.apc_order_number);
    if (royalMailConfigured() && Number.isFinite(orderId) && orderId > 0) {
      await deleteRoyalMailOrders([orderId]);
    }
    await query(
      `UPDATE collection_bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [booking.id],
    );
    return res.json({ cancelled: true });
  } catch (error) {
    if (error instanceof RoyalMailError) {
      return res.status(502).json({ error: error.message });
    }
    console.error('Royal Mail cancel failed', error instanceof Error ? error.message : 'request failed');
    return res.status(500).json({ error: 'Could not cancel the Royal Mail postage.' });
  }
});

export default router;
