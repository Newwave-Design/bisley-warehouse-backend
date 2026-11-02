/**
 * Local preview of an APC collection quote.
 * Calls the live service check only. There is no booking call.
 */

import express, { Response } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { query } from '../../db/index.js';

const router = express.Router();
const QUOTE_URL = 'https://apc.hypaship.com/api/3.0/ServiceAvailability.json';

interface PieceInput {
  weightKg?: number | string;
  lengthCm?: number | string;
  widthCm?: number | string;
  heightCm?: number | string;
  reference?: string;
}

function asList<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function nextCollectionDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() + 1);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getFullYear()}`;
}

function authHeader(): string | null {
  const user = process.env.APC_USER;
  const password = process.env.APC_PASSWORD;
  if (!user || !password) return null;
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

function text(value: unknown, fallback = ''): string {
  if (value == null || value === '') return fallback;
  return String(value);
}

router.post('/quote', authMiddleware, async (req: AuthRequest, res: Response) => {
  const remoteUser = authHeader();
  if (!remoteUser) {
    return res.status(500).json({ error: 'APC login is not configured on this computer' });
  }

  const pieces = asList<PieceInput>(req.body?.pieces).slice(0, 20);
  const collectionPostcode = text(req.body?.collectionPostcode).trim();
  const deliveryPostcode = text(req.body?.deliveryPostcode).trim();
  if (!pieces.length) return res.status(400).json({ error: 'Add at least one box' });
  if (!collectionPostcode || !deliveryPostcode) {
    return res.status(400).json({ error: 'Collection and delivery postcodes are required' });
  }

  const collectionDate = text(req.body?.collectionDate).trim() || nextCollectionDate();
  const items = pieces.map((piece) => ({
    Type: 'ALL',
    Weight: text(piece.weightKg, '1'),
    Length: text(piece.lengthCm, '1'),
    Width: text(piece.widthCm, '1'),
    Height: text(piece.heightCm, '1'),
    Reference: text(piece.reference),
  }));

  const body = {
    Orders: {
      Order: {
        CollectionDate: collectionDate,
        ReadyAt: '09:00',
        ClosedAt: '17:00',
        Collection: { PostalCode: collectionPostcode, CountryCode: 'GB' },
        Delivery: { PostalCode: deliveryPostcode, CountryCode: 'GB' },
        GoodsInfo: { GoodsValue: '50', Fragile: 'false' },
        ShipmentDetails: {
          NumberOfPieces: String(items.length),
          Items: { Item: items.length === 1 ? items[0] : items },
        },
      },
    },
  };

  try {
    const response = await fetch(QUOTE_URL, {
      method: 'POST',
      headers: {
        'remote-user': remoteUser,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    let payload: any = null;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    if (!response.ok || !payload) {
      return res.status(502).json({ error: 'APC did not return a service list' });
    }

    const availability = payload.ServiceAvailability || payload;
    const message = availability.Messages || null;
    const services = asList<any>(availability.Services?.Service).map((service) => {
      const total = service.TotalCost ?? service.Rate ?? null;
      return {
        code: text(service.ProductCode),
        name: text(service.ServiceName),
        carrier: text(service.Carrier),
        ruleMatch: String(service['@RuleMatch'] || service.RuleMatch || '').toLowerCase() === 'true',
        ruleName: text(service['@RuleMatchName'] || service.RuleMatchName),
        itemType: text(service.ItemType),
        tracked: String(service.Tracked).toLowerCase() === 'true',
        signed: String(service.Signed).toLowerCase() === 'true',
        collectionDate: text(service.CollectionDate),
        estimatedDeliveryDate: text(service.EstimatedDeliveryDate),
        latestBooking: text(service.LatestBookingDateTime),
        totalCost: total == null || total === '' ? null : text(total),
        currency: text(service.Currency),
      };
    }).filter((service) => service.code);

    return res.json({
      booked: false,
      pieces: items.length,
      collectionPostcode,
      deliveryPostcode,
      collectionDate,
      message,
      services,
    });
  } catch (error) {
    console.error('APC quote failed', error instanceof Error ? error.message : 'request failed');
    return res.status(502).json({ error: 'Could not reach APC' });
  }
});

router.post('/book', (_req, res: Response) => {
  res.status(403).json({
    booked: false,
    error: 'Booking is switched off on this preview. Nothing was sent to APC.',
  });
});

function collectLabels(payload: any): { trackingNumber: string; format: string; content: string }[] {
  const orders = asList<any>(payload?.Orders?.Order || payload?.Order);
  const labels: { trackingNumber: string; format: string; content: string }[] = [];
  for (const order of orders) {
    const items = asList<any>(order?.ShipmentDetails?.Items?.Item);
    for (const item of items) {
      const content = text(item?.Label?.Content);
      if (!content) continue;
      labels.push({
        trackingNumber: text(item.TrackingNumber),
        format: text(item?.Label?.Format, 'PDF'),
        content,
      });
    }
  }
  return labels;
}

router.get('/bookings', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT id, pick_list_id, sku, courier, service_code, service_name, waybill,
              collection_postcode, delivery_postcode, delivery_summary, pieces, status
       FROM collection_bookings
       WHERE status <> 'cancelled'
       ORDER BY created_at DESC`
    );
    return res.json({ bookings: result.rows });
  } catch (error) {
    console.error('Collection bookings failed', error instanceof Error ? error.message : 'query failed');
    return res.status(500).json({ error: 'Could not load bookings' });
  }
});

router.post('/bookings/:id/label', authMiddleware, async (req: AuthRequest, res: Response) => {
  const remoteUser = authHeader();
  if (!remoteUser) {
    return res.status(500).json({ error: 'APC login is not configured on this computer' });
  }

  const id = text(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'Unknown booking' });
  }

  try {
    const found = await query(
      `SELECT id, waybill, courier, status FROM collection_bookings WHERE id = $1`,
      [id]
    );
    const booking = found.rows[0] as { waybill?: string; courier?: string; status?: string } | undefined;
    if (!booking || booking.status === 'cancelled') {
      return res.status(404).json({ error: 'Unknown booking' });
    }
    if (booking.courier !== 'APC') {
      return res.status(409).json({ error: 'DX labels are not connected yet.' });
    }
    const waybill = text(booking.waybill).trim();
    if (!waybill) {
      return res.status(409).json({ error: 'This booking has no tracking number yet.' });
    }

    const url = `https://apc.hypaship.com/api/3.0/Orders/${encodeURIComponent(waybill)}.json?labelformat=PDF&markprinted=False&searchtype=CarrierWaybill&labels=True`;
    const response = await fetch(url, {
      headers: {
        'remote-user': remoteUser,
        Accept: 'application/json',
      },
    });
    const raw = await response.text();
    let payload: any = null;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    const labels = payload ? collectLabels(payload) : [];
    if (!response.ok || !labels.length) {
      return res.status(502).json({ error: 'APC did not return the label. Print it again in a few seconds.' });
    }
    return res.json({ labels });
  } catch (error) {
    console.error('APC label reprint failed', error instanceof Error ? error.message : 'request failed');
    return res.status(502).json({ error: 'Could not reach APC' });
  }
});

export default router;
