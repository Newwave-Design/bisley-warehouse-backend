/**
 * APC collection quote and booking.
 * A quote only asks which services can collect. Book collection creates the consignment.
 */

import express, { Response } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { getPool, query } from '../../db/index.js';
import { shipCollectionsDueToday } from '../../lib/ship-todays-collections.js';
import { rememberShipmentTracking } from '../../lib/shipment-tracking.js';
import { returnStockForCancelledCollection, takeStockForBookedCollection } from '../../lib/collection-stock.js';
import { actorName, reopenDispatchedPickList, shipBookedPickList } from '../../lib/pick-list-events.js';
import { fulfillPickListInMedusa } from '../../lib/medusa-fulfillment.js';
import { fitZpl } from '../../lib/zpl-fit.js';
import { addDxCollection, addDxConsignment, deleteDxConsignment, dxConfigured, DxError, fetchDxLabels, quoteDxCollection } from '../../lib/dx-freight.js';
import { openReturnReplacement, releaseReturnReplacement } from '../../lib/return-replacement.js';
import { markReturnRequestsBooked, reopenReturnRequests } from '../../lib/return-requests.js';
import { appropriateApcServices } from '../../lib/apc-service.js';

async function dropReplacements(pickListId: string | undefined, waybill: string) {
  if (!pickListId || !waybill) return;
  const rows = await query(
    `SELECT sku, outcome FROM collection_bookings
      WHERE pick_list_id = $1 AND waybill = $2 AND status <> 'cancelled'
        AND COALESCE(direction, 'outbound') = 'return'`,
    [pickListId, waybill]
  );
  for (const row of rows.rows) {
    await reopenReturnRequests(pickListId, row.sku).catch((error) => {
      console.warn('Reopening the return request failed', error instanceof Error ? error.message : 'failed');
    });
    if (row.outcome !== 'replace') continue;
    await releaseReturnReplacement(pickListId, row.sku).catch((error) => {
      console.warn('Removing the replacement pick failed', error instanceof Error ? error.message : 'failed');
    });
  }
}

const router = express.Router();
const QUOTE_URL = 'https://apc.hypaship.com/api/3.0/ServiceAvailability.json';
const ORDER_URL = 'https://apc.hypaship.com/api/3.0/Orders.json';
const WAREHOUSE_PHONE = '01873900095';
const COLLECTION = {
  CompanyName: 'OVARA PRODUCTS LIMITED',
  AddressLine1: 'Unit B7A, Brecon House',
  AddressLine2: 'Mamhilad Park Estate',
  PostalCode: 'NP4 0HZ',
  City: 'Pontypool',
  County: 'Torfaen',
  CountryCode: 'GB',
  Contact: {
    PersonName: 'Ovara Products',
    PhoneNumber: WAREHOUSE_PHONE,
  },
};

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

function londonParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const read = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
    weekday: read('weekday'),
    hour: Number(read('hour')),
    minute: Number(read('minute')),
  };
}

function apcDate(year: number, month: number, day: number): string {
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
}

function shiftLondonDate(days: number, now = new Date()) {
  const parts = londonParts(now);
  return londonParts(new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12)));
}

function weekend(weekday: string): boolean {
  return weekday === 'Sat' || weekday === 'Sun';
}

function nextCollectionDate(now = new Date()): string {
  for (let days = 1; days < 8; days += 1) {
    const shifted = shiftLondonDate(days, now);
    if (!weekend(shifted.weekday)) return apcDate(shifted.year, shifted.month, shifted.day);
  }
  const fallback = shiftLondonDate(1, now);
  return apcDate(fallback.year, fallback.month, fallback.day);
}

function todayCollectionDate(now = new Date()): string | null {
  const parts = londonParts(now);
  if (weekend(parts.weekday)) return null;
  return apcDate(parts.year, parts.month, parts.day);
}

function londonStamp(now = new Date()): string {
  const parts = londonParts(now);
  const hour = String(parts.hour).padStart(2, '0');
  const minute = String(parts.minute).padStart(2, '0');
  return `${parts.year}${String(parts.month).padStart(2, '0')}${String(parts.day).padStart(2, '0')}${hour}${minute}`;
}

function bookingStamp(value: string): string {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  if (!match) return '';
  return `${match[3]}${match[2]}${match[1]}${match[4] || '23'}${match[5] || '59'}`;
}

function dateSortKey(value: string): number {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return match ? Number(`${match[3]}${match[2]}${match[1]}`) : 0;
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

async function deliveredCourier(pickListId: string): Promise<'APC' | 'DX'> {
  const booked = await query(
    `SELECT courier FROM collection_bookings
      WHERE pick_list_id = $1 AND status <> 'cancelled'
        AND COALESCE(direction, 'outbound') <> 'return'
      ORDER BY created_at DESC
      LIMIT 1`,
    [pickListId]
  );
  const fromBooking = text(booked.rows[0]?.courier).toUpperCase();
  if (fromBooking === 'DX' || fromBooking === 'APC') return fromBooking;
  const list = await query(
    `SELECT shipping_method_name, selected_courier_code FROM pick_lists WHERE id = $1`,
    [pickListId]
  );
  const blob = `${text(list.rows[0]?.shipping_method_name)} ${text(list.rows[0]?.selected_courier_code)}`.toUpperCase();
  return blob.includes('DX') ? 'DX' : 'APC';
}

router.post('/quote', authMiddleware, async (req: AuthRequest, res: Response) => {
  const pieces = asList<PieceInput>(req.body?.pieces).slice(0, 20);
  const collectionPostcode = text(req.body?.collectionPostcode).trim();
  const deliveryPostcode = text(req.body?.deliveryPostcode).trim();
  if (!pieces.length) return res.status(400).json({ error: 'Add at least one box' });
  if (!collectionPostcode || !deliveryPostcode) {
    return res.status(400).json({ error: 'Collection and delivery postcodes are required' });
  }
  const returning = text(req.body?.direction).trim().toLowerCase() === 'return';
  const agreedDate = returning ? agreedCollectionDate(req.body?.collectionDate) : '';
  const pickListId = text(req.body?.pickListId).trim();
  let courier: 'APC' | 'DX' = text(req.body?.courier).trim().toUpperCase() === 'DX' ? 'DX' : 'APC';
  if (returning && /^[0-9a-f-]{36}$/i.test(pickListId)) courier = await deliveredCourier(pickListId);
  if (returning && !agreedDate) {
    return res.status(400).json({ error: 'Enter the collection date agreed with the customer. It has to be a weekday that has not passed.' });
  }
  if (courier === 'DX') {
    if (!dxConfigured()) return res.status(500).json({ error: 'DX login is not configured' });
    try {
      const quoted = quoteDxCollection({
        pieces: pieces.map((piece) => ({
          weightKg: Number(piece.weightKg),
          lengthCm: Number(piece.lengthCm),
          widthCm: Number(piece.widthCm),
          heightCm: Number(piece.heightCm),
        })),
        collectionPostcode,
        deliveryPostcode,
        collectionDate: returning ? agreedDate : text(req.body?.collectionDate).trim(),
      });
      return res.json({ ...quoted, courier });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not build DX collection dates';
      return res.status(400).json({ error: message });
    }
  }

  const remoteUser = authHeader();
  if (!remoteUser) {
    return res.status(500).json({ error: 'APC login is not configured on this computer' });
  }

  const requestedDate = agreedDate || text(req.body?.collectionDate).trim();
  const items = pieces.map((piece) => ({
    Type: 'ALL',
    Weight: text(piece.weightKg, '1'),
    Length: text(piece.lengthCm, '1'),
    Width: text(piece.widthCm, '1'),
    Height: text(piece.heightCm, '1'),
    Reference: text(piece.reference),
  }));
  const today = todayCollectionDate();
  const dates = requestedDate
    ? [requestedDate]
    : [today, nextCollectionDate()].filter((date, index, list): date is string => Boolean(date) && list.indexOf(date) === index);

  try {
    const quoted = await Promise.all(dates.map((collectionDate) => quoteCollectionDate(remoteUser, collectionDate, collectionPostcode, deliveryPostcode, items)));
    const failed = quoted.find((entry) => !entry.ok);
    if (failed) return res.status(502).json({ error: 'APC did not return a service list' });

    const byDate = new Map<string, QuotedService[]>();
    for (const entry of quoted) {
      for (const service of entry.services) {
        if (!requestedDate && !openForBooking(service.latestBooking)) continue;
        const date = service.collectionDate || entry.collectionDate;
        const list = byDate.get(date) || [];
        if (!list.some((existing) => existing.code === service.code)) list.push(service);
        byDate.set(date, list);
      }
    }
    const boxes = items.map((item) => ({
      weightKg: Number(item.Weight),
      lengthCm: Number(item.Length),
      widthCm: Number(item.Width),
      heightCm: Number(item.Height),
    }));
    const offered = [...byDate.entries()]
      .sort((left, right) => dateSortKey(left[0]) - dateSortKey(right[0]))
      .map(([date, services]) => ({ date, services }));
    const collectionDates = offered
      .map((entry) => ({ date: entry.date, services: appropriateApcServices(entry.services, boxes) }))
      .filter((entry) => entry.services.length);
    const services = collectionDates[0]?.services || [];
    if (!collectionDates.length) {
      const apcListedSomething = offered.some((entry) => entry.services.length);
      return res.status(409).json({
        error: apcListedSomething
          ? 'No APC service fits this box. Check the weight and size.'
          : 'APC cannot collect on that date. Call the customer and agree another date.',
      });
    }
    if (returning) {
      const exact = collectionDates.filter((entry) => entry.date === agreedDate && entry.services.length);
      if (!exact.length) {
        return res.status(409).json({ error: 'APC cannot collect on that date. Call the customer and agree another date.' });
      }
      return res.json({
        booked: false,
        courier,
        pieces: items.length,
        collectionPostcode,
        deliveryPostcode,
        collectionDate: agreedDate,
        collectionDates: exact,
        message: quoted.find((entry) => entry.message)?.message || null,
        services: exact[0].services,
      });
    }

    return res.json({
      booked: false,
      pieces: items.length,
      collectionPostcode,
      deliveryPostcode,
      collectionDate: collectionDates[0]?.date || dates[0] || nextCollectionDate(),
      collectionDates,
      message: quoted.find((entry) => entry.message)?.message || null,
      services,
    });
  } catch (error) {
    console.error('APC quote failed', error instanceof Error ? error.message : 'request failed');
    return res.status(502).json({ error: 'Could not reach APC' });
  }
});

interface QuotedService {
  code: string;
  name: string;
  carrier: string;
  ruleMatch: boolean;
  ruleName: string;
  itemType: string;
  tracked: boolean;
  signed: boolean;
  collectionDate: string;
  estimatedDeliveryDate: string;
  latestBooking: string;
  totalCost: string | null;
  currency: string;
}

function openForBooking(latestBooking: string, now = new Date()): boolean {
  const latest = bookingStamp(latestBooking);
  if (!latest) return true;
  return latest >= londonStamp(now);
}

async function quoteCollectionDate(
  remoteUser: string,
  collectionDate: string,
  collectionPostcode: string,
  deliveryPostcode: string,
  items: { Type: string; Weight: string; Length: string; Width: string; Height: string; Reference: string }[],
): Promise<{ ok: boolean; collectionDate: string; message: unknown; services: QuotedService[] }> {
  const response = await fetch(QUOTE_URL, {
    method: 'POST',
    headers: {
      'remote-user': remoteUser,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
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
    }),
  });
  const raw = await response.text();
  let payload: any = null;
  try { payload = JSON.parse(raw); } catch { payload = null; }
  if (!response.ok || !payload) return { ok: false, collectionDate, message: null, services: [] };

  const availability = payload.ServiceAvailability || payload;
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
  return { ok: true, collectionDate, message: availability.Messages || null, services };
}

function collectionDateOf(value: unknown): string {
  const raw = text(value).trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) return raw;
  return nextCollectionDate();
}

/** A return can only be collected on the weekday the customer agreed. */
function agreedCollectionDate(value: unknown, now = new Date()): string {
  const raw = text(value).trim();
  const dmy = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const day = Number(dmy?.[1] || iso?.[3]);
  const month = Number(dmy?.[2] || iso?.[2]);
  const year = Number(dmy?.[3] || iso?.[1]);
  if (!day || !month || !year) return '';
  const parts = londonParts(new Date(Date.UTC(year, month - 1, day, 12)));
  if (parts.year !== year || parts.month !== month || parts.day !== day) return '';
  if (weekend(parts.weekday)) return '';
  const today = londonParts(now);
  const key = year * 10000 + month * 100 + day;
  const todayKey = today.year * 10000 + today.month * 100 + today.day;
  if (key < todayKey) return '';
  return apcDate(year, month, day);
}

function fieldErrors(entry: any): string[] {
  const fields = asList<any>(entry?.ErrorFields?.ErrorField || entry?.ErrorFields);
  return fields.map((field) => {
    const name = text(field?.FieldName).trim();
    const message = text(field?.ErrorMessage || field?.Description).trim();
    if (!message) return '';
    return name ? `${name}: ${message}` : message;
  }).filter(Boolean);
}

function apcMessages(node: any): { ok: boolean; detail: string } {
  const raw = node?.Messages?.Message || node?.Messages;
  const list = asList<any>(raw).filter((entry) => entry && (entry.Code || entry.Description || typeof entry === 'string'));
  const codes = list.map((entry) => text(entry?.Code).toUpperCase());
  const detail = list.flatMap((entry) => {
    const description = text(entry?.Description || (typeof entry === 'string' ? entry : '')).trim();
    return [description, ...fieldErrors(entry)].filter(Boolean);
  }).join('. ');
  const ok = !codes.length || codes.every((code) => ['', '0', '00', 'SUCCESS', 'OK'].includes(code));
  return { ok, detail };
}

function findWaybill(order: any): string {
  const direct = text(order?.WayBill || order?.Waybill || order?.CarrierWaybill).trim();
  if (direct) return direct;
  for (const depot of asList<any>(order?.Depots?.Depot)) {
    const value = text(depot?.Waybill || depot?.WayBill).trim();
    if (value) return value;
  }
  return '';
}

function clipApc(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  const clipped = (space > Math.floor(max / 2) ? cut.slice(0, space) : clean.slice(0, max)).trim();
  return clipped || clean.slice(0, max);
}

/** APC rejects Address Line 1 and 2 at 64 characters. Keep both lines, breaking on a comma where that still fits. */
function apcStreet(line1: string, line2: string): [string, string] {
  const source = [line1, line2].map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ');
  const max = 63;
  if (source.length <= max) return [source, ''];
  const comma = source.lastIndexOf(',');
  if (comma > 0) {
    const head = source.slice(0, comma).trim();
    const tail = source.slice(comma + 1).trim();
    if (head && tail && head.length <= max && tail.length <= max) return [head, tail];
  }
  const words = source.split(' ').filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const piece = word.length > max ? word.slice(0, max) : word;
    if (!current) current = piece;
    else if (`${current} ${piece}`.length <= max) current = `${current} ${piece}`;
    else {
      lines.push(current);
      if (lines.length >= 2) return [lines[0], lines[1] || ''];
      current = piece;
    }
  }
  if (current && lines.length < 2) lines.push(current);
  return [lines[0] || source.slice(0, max), lines[1] || ''];
}

function deliveryFrom(row: { customer_name?: string; customer_email?: string; shipping_address?: any }) {
  const address = row.shipping_address || {};
  const person = text(`${address.first_name || ''} ${address.last_name || ''}`).trim() || text(row.customer_name).trim();
  const company = text(address.company).trim();
  return {
    company: company || person,
    person,
    email: text(row.customer_email || address.email).trim(),
    phone: text(address.phone).trim(),
    line1: text(address.address_1).trim(),
    line2: text(address.address_2).trim(),
    city: text(address.city).trim(),
    county: text(address.province).trim(),
    postcode: text(address.postal_code).trim().toUpperCase(),
    country: text(address.country_code, 'GB').trim().toUpperCase() || 'GB',
  };
}

/** APC will not create a collection unless PhoneNumber is set. A mobile also goes in MobileNumber. */
function apcContactNumbers(value: string): { PhoneNumber: string; MobileNumber?: string } {
  let digits = value.replace(/[^\d+]/g, '');
  if (digits.startsWith('+44')) digits = `0${digits.slice(3)}`;
  else if (digits.startsWith('0044')) digits = `0${digits.slice(4)}`;
  else if (/^44\d{10}$/.test(digits)) digits = `0${digits.slice(2)}`;
  digits = digits.replace(/\D/g, '').slice(0, 15);
  if (digits.length < 10) return { PhoneNumber: WAREHOUSE_PHONE };
  if (digits.startsWith('07')) return { PhoneNumber: digits, MobileNumber: digits };
  return { PhoneNumber: digits };
}

router.post('/book', authMiddleware, async (req: AuthRequest, res: Response) => {
  const returning = text(req.body?.direction).trim().toLowerCase() === 'return';
  const outcome = text(req.body?.outcome).trim().toLowerCase();
  const agreedDate = returning ? agreedCollectionDate(req.body?.collectionDate) : '';
  const pickListId = text(req.body?.pickListId).trim();
  let courier: 'APC' | 'DX' = text(req.body?.courier).trim().toUpperCase() === 'DX' ? 'DX' : 'APC';
  if (returning && /^[0-9a-f-]{36}$/i.test(pickListId)) courier = await deliveredCourier(pickListId);
  if (returning && outcome !== 'refund' && outcome !== 'replace') {
    return res.status(400).json({ error: 'Choose whether this return is a refund or a replacement.' });
  }
  if (returning && !agreedDate) {
    return res.status(400).json({ error: 'Enter the collection date agreed with the customer. It has to be a weekday that has not passed.' });
  }
  const remoteUser = courier === 'APC' ? authHeader() : null;
  if (courier === 'APC' && !remoteUser) return res.status(500).json({ error: 'APC login is not configured' });
  if (courier === 'DX' && !dxConfigured()) return res.status(500).json({ error: 'DX login is not configured' });

  if (!/^[0-9a-f-]{36}$/i.test(pickListId)) return res.status(400).json({ error: 'Choose an order to book' });
  const serviceCode = text(req.body?.serviceCode).trim();
  const serviceName = text(req.body?.serviceName).trim().slice(0, 120);
  if (!serviceCode) return res.status(400).json({ error: 'Choose a service' });

  const pieces = asList<any>(req.body?.pieces).slice(0, 20).map((piece) => ({
    sku: text(piece?.sku).trim(),
    title: text(piece?.title).trim().slice(0, 160),
    weightKg: text(piece?.weightKg).trim(),
    lengthCm: text(piece?.lengthCm).trim(),
    widthCm: text(piece?.widthCm).trim(),
    heightCm: text(piece?.heightCm).trim(),
  })).filter((piece) => piece.weightKg && piece.lengthCm && piece.widthCm && piece.heightCm);
  if (!pieces.length) return res.status(400).json({ error: 'Add at least one box' });

  try {
    const found = await query(
      `SELECT id, pick_list_number, customer_name, customer_email, shipping_address, medusa_order_id
         FROM pick_lists WHERE id = $1`,
      [pickListId]
    );
    const list = found.rows[0] as { pick_list_number?: string; customer_name?: string; customer_email?: string; shipping_address?: any; medusa_order_id?: string } | undefined;
    if (!list) return res.status(404).json({ error: 'Unknown order' });
    if (!returning && String(list.medusa_order_id || '').startsWith('manual-')) {
      return res.status(400).json({ error: 'This send is by hand. Print an address label and mark it shipped. Do not book APC or DX.' });
    }

    const requestedSkus = [...new Set(asList<any>(req.body?.skus).map((sku) => text(sku).trim()).filter(Boolean))];
    const skus = requestedSkus.length ? requestedSkus : [...new Set(pieces.map((piece) => piece.sku).filter(Boolean))];
    if (skus.length) {
      const already = await query(
        `SELECT sku FROM collection_bookings
          WHERE pick_list_id = $1 AND sku = ANY($2::text[]) AND status <> 'cancelled'
            AND COALESCE(direction, 'outbound') = $3`,
        [pickListId, skus, returning ? 'return' : 'outbound']
      );
      if (already.rows.length) {
        return res.status(409).json({ error: returning ? 'This item already has a return collection' : 'One of these items already has a collection' });
      }
    }

    const delivery = deliveryFrom(list);
    if (returning) {
      const given = text(req.body?.phone).trim();
      if (given) delivery.phone = given;
    }
    if (!['GB', 'UK'].includes(delivery.country)) {
      return res.status(400).json({ error: returning ? 'A return can only be collected from a UK address' : `${courier} collections are only booked to a UK address` });
    }
    if (!delivery.line1 || !delivery.city || !delivery.postcode || !delivery.company) {
      return res.status(400).json({ error: 'This order needs a name, street, city and postcode before it can be booked' });
    }

    const items = pieces.map((piece) => ({
      Type: 'ALL',
      Weight: piece.weightKg,
      Length: piece.lengthCm,
      Width: piece.widthCm,
      Height: piece.heightCm,
      Reference: (piece.sku || piece.title || 'Box').slice(0, 30),
    }));
    const reference = text(list.pick_list_number).trim().slice(0, 20);
    let waybill = '';
    let orderNumber = '';
    let bookedService = serviceCode;
    let bookedName = serviceName;
    let collectionDate = (returning ? agreedDate : text(req.body?.collectionDate).trim()).slice(0, 40) || null;
    let savedPieces: { reference: string; trackingNumber: string; title: string; weightKg: string; lengthCm: string; widthCm: string; heightCm: string }[] = [];

    if (courier === 'DX') {
      try {
        const booked = returning
          ? await addDxCollection({
              reference,
              serviceCode,
              collectionDate: agreedDate,
              collection: {
                name: delivery.person,
                company: text(list.shipping_address?.company).trim(),
                email: delivery.email,
                phone: delivery.phone,
                line1: delivery.line1,
                line2: delivery.line2,
                city: delivery.city,
                county: delivery.county,
                postcode: delivery.postcode,
              },
              pieces: pieces.map((piece) => ({
                title: piece.title,
                weightKg: Number(piece.weightKg),
                lengthCm: Number(piece.lengthCm),
                widthCm: Number(piece.widthCm),
                heightCm: Number(piece.heightCm),
              })),
            })
          : await addDxConsignment({
              reference,
              serviceCode,
              collectionDate: text(req.body?.collectionDate).trim(),
              delivery: {
                name: delivery.person,
                company: text(list.shipping_address?.company).trim(),
                email: delivery.email,
                phone: delivery.phone,
                line1: delivery.line1,
                line2: delivery.line2,
                city: delivery.city,
                county: delivery.county,
                postcode: delivery.postcode,
              },
              pieces: pieces.map((piece) => ({
                title: piece.title,
                weightKg: Number(piece.weightKg),
                lengthCm: Number(piece.lengthCm),
                widthCm: Number(piece.widthCm),
                heightCm: Number(piece.heightCm),
              })),
            });
        waybill = booked.consignmentNumber;
        orderNumber = booked.routingStream;
        bookedService = booked.serviceCode;
        bookedName = booked.serviceDescription || serviceName;
        collectionDate = booked.collectionDate;
        savedPieces = pieces.map((piece, index) => ({
          reference: (piece.sku || piece.title || 'Box').slice(0, 30),
          trackingNumber: booked.trackingNumbers[index] || '',
          title: piece.title,
          weightKg: piece.weightKg,
          lengthCm: piece.lengthCm,
          widthCm: piece.widthCm,
          heightCm: piece.heightCm,
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not reach DX. Nothing was saved.';
        const status = error instanceof DxError ? error.status : 502;
        console.error('DX rejected the collection', message);
        return res.status(status).json({ error: message });
      }
    } else {
    const contact: Record<string, string> = {};
    if (delivery.person) contact.PersonName = clipApc(delivery.person, 63);
    Object.assign(contact, apcContactNumbers(delivery.phone));
    if (delivery.email) contact.Email = delivery.email;
    const [addressLine1, addressLine2] = apcStreet(delivery.line1, delivery.line2);
    const customerParty = {
      CompanyName: clipApc(delivery.company, 34),
      AddressLine1: addressLine1,
      AddressLine2: addressLine2,
      PostalCode: delivery.postcode,
      City: clipApc(delivery.city, 31),
      County: clipApc(delivery.county, 31),
      CountryCode: 'GB',
      ...(Object.keys(contact).length ? { Contact: contact } : {}),
    };

    const response = await fetch(ORDER_URL, {
      method: 'POST',
      headers: {
        'remote-user': remoteUser || '',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        Orders: {
          Order: {
            CollectionDate: returning ? agreedDate : collectionDateOf(req.body?.collectionDate),
            ReadyAt: '09:00',
            ClosedAt: '17:00',
            ProductCode: serviceCode,
            Reference: reference,
            Collection: returning ? customerParty : COLLECTION,
            Delivery: returning ? COLLECTION : customerParty,
            GoodsInfo: { GoodsValue: '50', Fragile: 'false' },
            ShipmentDetails: {
              NumberOfPieces: String(items.length),
              Items: { Item: items.length === 1 ? items[0] : items },
            },
          },
        },
      }),
    });
    const raw = await response.text();
    let payload: any = null;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    const order = asList<any>(payload?.Orders?.Order || payload?.Order)[0] || payload;
    const message = order ? apcMessages(order) : { ok: false, detail: '' };
    waybill = order ? findWaybill(order) : '';
    if (!response.ok || !payload || !message.ok) {
      console.error('APC rejected the collection', message.detail || response.status);
      return res.status(502).json({ error: message.detail || 'APC did not accept the collection. Nothing was saved.' });
    }
    if (!waybill) {
      return res.status(502).json({ error: 'APC replied without a tracking number. Check APC before booking this order again.' });
    }
    if (returning) {
      const bookedDay = text(order?.CollectionDate).trim();
      if (bookedDay && bookedDay !== agreedDate) {
        const orderNumber = text(order?.OrderNumber).trim();
        const lookup = orderNumber || waybill;
        await fetch(`https://apc.hypaship.com/api/3.0/Orders/${encodeURIComponent(lookup)}.json${orderNumber ? '' : '?searchtype=CarrierWaybill'}`, {
          method: 'PUT',
          headers: { 'remote-user': remoteUser || '', 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ Orders: { Order: { Status: 'CANCELLED' } } }),
        }).catch(() => undefined);
        return res.status(409).json({ error: `APC booked ${bookedDay} instead of the agreed date ${agreedDate}. That collection was cancelled. Call the customer and agree another date.` });
      }
      collectionDate = agreedDate;
    }

    const tracked = asList<any>(order?.ShipmentDetails?.Items?.Item);
    savedPieces = pieces.map((piece, index) => ({
      reference: items[index].Reference,
      trackingNumber: text(tracked[index]?.TrackingNumber || tracked.find((item) => text(item?.Reference) === items[index].Reference)?.TrackingNumber),
      title: piece.title,
      weightKg: piece.weightKg,
      lengthCm: piece.lengthCm,
      widthCm: piece.widthCm,
      heightCm: piece.heightCm,
    }));
    orderNumber = text(order?.OrderNumber).trim();
    collectionDate = returning
      ? agreedDate
      : (text(order?.CollectionDate).trim() || text(req.body?.collectionDate).trim()).slice(0, 40) || null;
    }
    const summary = [delivery.company, delivery.line1, delivery.city, delivery.postcode].filter(Boolean).join(', ');
    const collectionPostcode = returning ? delivery.postcode : COLLECTION.PostalCode;
    const deliveryPostcode = returning ? COLLECTION.PostalCode : delivery.postcode;
    const rowSkus = skus.length ? skus : [`extra-${Date.now().toString(36)}`];

    const client = await getPool().connect();
    const saved = [];
    try {
      await client.query('BEGIN');
      for (const sku of rowSkus) {
        const inserted = await client.query(
          `INSERT INTO collection_bookings
             (pick_list_id, sku, courier, service_code, service_name, waybill, apc_order_number,
              collection_postcode, delivery_postcode, delivery_summary, pieces, status, collection_date, direction, outcome)
           VALUES ($1, $2, $12, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'booked', $11, $13, $14)
           RETURNING id, pick_list_id, sku, courier, service_code, service_name, waybill,
                     collection_postcode, delivery_postcode, delivery_summary, pieces, status, collection_date, direction, outcome`,
          [pickListId, sku, bookedService, bookedName || null, waybill, orderNumber || null, collectionPostcode, deliveryPostcode, summary, JSON.stringify(savedPieces), collectionDate, courier, returning ? 'return' : 'outbound', returning ? outcome : null]
        );
        saved.push(inserted.rows[0]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Saving collection failed', error instanceof Error ? error.message : 'query failed');
      return res.status(500).json({ error: `${courier} created tracking ${waybill}, but it could not be saved here. Do not book it again.` });
    } finally {
      client.release();
    }

    console.log(`${courier} ${returning ? 'return ' : ''}collection booked ${waybill} for pick list ${pickListId}`);
    let replacement: { id: string; pick_list_number: string } | null = null;
    if (returning && outcome === 'replace') {
      for (const sku of rowSkus) {
        replacement = await openReturnReplacement(pickListId, sku).catch((error) => {
          console.warn('Opening the replacement pick failed', error instanceof Error ? error.message : 'failed');
          return replacement;
        });
      }
    }
    if (returning && outcome === 'refund') {
      for (const sku of rowSkus) {
        await releaseReturnReplacement(pickListId, sku).catch((error) => {
          console.warn('Removing the replacement pick failed', error instanceof Error ? error.message : 'failed');
        });
      }
    }
    if (returning) {
      for (const row of saved) {
        await markReturnRequestsBooked(pickListId, row.sku, row.id).catch((error) => {
          console.warn('Marking the return request booked failed', error instanceof Error ? error.message : 'failed');
        });
      }
    }
    if (!returning) {
      await shipBookedPickList(pickListId, actorName((req as AuthRequest).user)).catch((error) => {
        console.warn('Marking the booked order shipped failed', error instanceof Error ? error.message : 'failed');
      });
      await fulfillPickListInMedusa(pickListId).catch((error) => {
        console.warn('Fulfilling the booked order failed', error instanceof Error ? error.message : 'failed');
      });
      await rememberShipmentTracking(pickListId).catch((error) => {
        console.warn('Saving shipment tracking failed', error instanceof Error ? error.message : 'failed');
      });
      await takeStockForBookedCollection(pickListId, text(req.user?.id)).catch((error) => {
        console.warn('Removing booked collection stock failed', error instanceof Error ? error.message : 'failed');
      });
      await shipCollectionsDueToday().catch((error) => {
        console.warn('Shipping today\'s collections failed', error instanceof Error ? error.message : 'failed');
      });
    }
    return res.status(201).json({ booked: true, waybill, bookings: saved, replacement });
  } catch (error) {
    console.error('Collection booking failed', error instanceof Error ? error.message : 'request failed');
    return res.status(502).json({ error: `Could not reach ${courier}. Nothing was saved.` });
  }
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
              collection_postcode, delivery_postcode, delivery_summary, pieces, status, collection_date,
              direction, outcome, created_at
       FROM collection_bookings
       WHERE status <> 'cancelled'
         AND COALESCE(direction, 'outbound') ${text(_req.query.direction).trim().toLowerCase() === 'return' ? '=' : '<>'} 'return'
       ORDER BY created_at DESC`
    );
    return res.json({ bookings: result.rows });
  } catch (error) {
    console.error('Collection bookings failed', error instanceof Error ? error.message : 'query failed');
    return res.status(500).json({ error: 'Could not load bookings' });
  }
});

router.post('/bookings/:id/label', authMiddleware, async (req: AuthRequest, res: Response) => {
  const id = text(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'Unknown booking' });
  }

  try {
    const found = await query(
      `SELECT id, waybill, apc_order_number, pieces, courier, status FROM collection_bookings WHERE id = $1`,
      [id]
    );
    const booking = found.rows[0] as { waybill?: string; apc_order_number?: string; pieces?: { trackingNumber?: string }[]; courier?: string; status?: string } | undefined;
    if (!booking || booking.status === 'cancelled') {
      return res.status(404).json({ error: 'Unknown booking' });
    }
    const waybill = text(booking.waybill).trim();
    if (!waybill) {
      return res.status(409).json({ error: 'This booking has no tracking number yet.' });
    }

    const format = text(req.query.format).toUpperCase() === 'ZPL' ? 'ZPL' : 'PDF';
    if (booking.courier === 'DX') {
      if (!dxConfigured()) return res.status(500).json({ error: 'DX login is not configured' });
      const tracking = (Array.isArray(booking.pieces) ? booking.pieces : []).map((piece) => text(piece?.trackingNumber)).filter(Boolean);
      const labels = await fetchDxLabels(waybill, text(booking.apc_order_number) || 'F', format, tracking);
      if (format === 'ZPL') {
        for (const label of labels) {
          const zpl = Buffer.from(label.content, 'base64').toString('latin1');
          if (zpl.includes('^XA')) label.content = Buffer.from(fitZpl(zpl), 'latin1').toString('base64');
        }
      }
      return res.json({ labels });
    }
    if (booking.courier !== 'APC') {
      return res.status(409).json({ error: 'This courier cannot print a label here.' });
    }
    const remoteUser = authHeader();
    if (!remoteUser) {
      return res.status(500).json({ error: 'APC login is not configured on this computer' });
    }
    const url = `https://apc.hypaship.com/api/3.0/Orders/${encodeURIComponent(waybill)}.json?labelformat=${format}&markprinted=True&searchtype=CarrierWaybill&labels=True`;
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
    if (format === 'ZPL') {
      for (const label of labels) {
        const zpl = Buffer.from(label.content, 'base64').toString('latin1');
        if (zpl.includes('^XA')) label.content = Buffer.from(fitZpl(zpl), 'latin1').toString('base64');
      }
    }
    return res.json({ labels });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not reach the courier';
    console.error('Label reprint failed', message);
    return res.status(error instanceof DxError ? error.status : 502).json({ error: message });
  }
});

router.post('/bookings/:id/cancel', authMiddleware, async (req: AuthRequest, res: Response) => {
  const id = text(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'Unknown booking' });
  }

  try {
    const found = await query(
      `SELECT id, pick_list_id, waybill, apc_order_number, courier, status, direction
       FROM collection_bookings WHERE id = $1`,
      [id]
    );
    const booking = found.rows[0] as {
      pick_list_id?: string; waybill?: string; apc_order_number?: string; courier?: string; status?: string; direction?: string
    } | undefined;
    if (!booking) return res.status(404).json({ error: 'Unknown booking' });
    if (booking.status === 'cancelled') return res.json({ cancelled: true });
    const waybill = text(booking.waybill).trim();
    if (booking.courier === 'DX') {
      if (!dxConfigured()) return res.status(500).json({ error: 'DX login is not configured' });
      try {
        await deleteDxConsignment(waybill, text(booking.apc_order_number) || 'F');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'DX did not cancel the collection. It is still booked here.';
        return res.status(502).json({ error: message });
      }
      await dropReplacements(booking.pick_list_id, waybill);
      await query(
        `UPDATE collection_bookings
            SET status = 'cancelled', updated_at = NOW()
          WHERE pick_list_id = $1 AND waybill = $2 AND status <> 'cancelled'`,
        [booking.pick_list_id, waybill]
      );
      if (waybill && booking.direction !== 'return') {
        await query(
          `UPDATE pick_lists
              SET tracking_number = NULL, carrier = NULL, updated_at = NOW()
            WHERE id = $1 AND tracking_number = $2`,
          [booking.pick_list_id, waybill]
        );
      }
      if (booking.pick_list_id && waybill && booking.direction !== 'return') {
        await returnStockForCancelledCollection(booking.pick_list_id, waybill, text(req.user?.id)).catch((error) => {
          console.warn('Returning cancelled collection stock failed', error instanceof Error ? error.message : 'failed');
        });
        await reopenDispatchedPickList(booking.pick_list_id, actorName(req.user)).catch((error) => {
          console.warn('Moving the cancelled collection back to picked failed', error instanceof Error ? error.message : 'failed');
        });
      }
      return res.json({ cancelled: true });
    }
    if (booking.courier !== 'APC') return res.status(409).json({ error: 'Only an APC or DX collection can be cancelled here.' });
    const remoteUser = authHeader();
    if (!remoteUser) return res.status(500).json({ error: 'APC login is not configured on this computer' });

    const orderNumber = text(booking.apc_order_number).trim();
    const lookup = orderNumber || waybill;
    if (!lookup) return res.status(409).json({ error: 'This booking has no APC order to cancel.' });

    const url = `https://apc.hypaship.com/api/3.0/Orders/${encodeURIComponent(lookup)}.json${orderNumber ? '' : '?searchtype=CarrierWaybill'}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'remote-user': remoteUser,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ Orders: { Order: { Status: 'CANCELLED' } } }),
    });
    const raw = await response.text();
    let payload: any = null;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    const order = payload ? (asList<any>(payload?.Orders?.Order || payload?.Order)[0] || payload) : null;
    const message = order ? apcMessages(order) : { ok: false, detail: '' };
    const detail = `${message.detail} ${raw}`.toLowerCase();
    const alreadyGone = /cancel|not found|does not exist/.test(detail);
    if ((!response.ok || !message.ok) && !alreadyGone) {
      return res.status(502).json({ error: message.detail || 'APC did not cancel the collection. It is still booked here.' });
    }

    await dropReplacements(booking.pick_list_id, waybill);
    await query(
      `UPDATE collection_bookings
          SET status = 'cancelled', updated_at = NOW()
        WHERE pick_list_id = $1 AND waybill = $2 AND status <> 'cancelled'`,
      [booking.pick_list_id, waybill]
    );
    if (waybill && booking.direction !== 'return') {
      await query(
        `UPDATE pick_lists
            SET tracking_number = NULL, carrier = NULL, updated_at = NOW()
          WHERE id = $1 AND tracking_number = $2`,
        [booking.pick_list_id, waybill]
      );
    }
    if (booking.pick_list_id && waybill && booking.direction !== 'return') {
      await returnStockForCancelledCollection(booking.pick_list_id, waybill, text(req.user?.id)).catch((error) => {
        console.warn('Returning cancelled collection stock failed', error instanceof Error ? error.message : 'failed');
      });
      await reopenDispatchedPickList(booking.pick_list_id, actorName(req.user)).catch((error) => {
        console.warn('Moving the cancelled collection back to picked failed', error instanceof Error ? error.message : 'failed');
      });
    }
    return res.json({ cancelled: true });
  } catch (error) {
    console.error('APC cancel failed', error instanceof Error ? error.message : 'request failed');
    return res.status(502).json({ error: 'Could not reach APC. The collection is still booked here.' });
  }
});

const FAMILY_RULES: [RegExp, string][] = [
  [/^fern-/, 'Fern'],
  [/multidesk/, 'MultiDesk'],
  [/multidrawer|multi-drawer/, 'MultiDrawer'],
  [/filing-cabinet/, 'Filing Cabinets'],
  [/locker/, 'Lockers'],
  [/note-pedestal|pedestal/, 'Pedestals'],
  [/plan-file|plan-chest/, 'Plan Files'],
  [/home-filer|suspension-filing/, 'Home Filer'],
  [/glide/, 'Glide'],
  [/^bob-/, 'BOB'],
];

function familyFromHandle(handle: string): string {
  const value = handle.toLowerCase();
  for (const [rule, label] of FAMILY_RULES) if (rule.test(value)) return label;
  return '';
}

function codesFromQuery(value: unknown): string[] {
  return [...new Set(String(value || '').split(',').map((code) => code.trim().toUpperCase()).filter(Boolean))];
}

interface TemplatePiece {
  title: string
  productCode: string
  weightKg: string
  lengthCm: string
  widthCm: string
  heightCm: string
  custom: boolean
  boxCode: string
}

function cleanPieces(value: unknown): TemplatePiece[] {
  return asList<any>(value).slice(0, 20).map((piece) => ({
    title: text(piece?.title).trim().slice(0, 160),
    productCode: text(piece?.productCode).trim().toUpperCase().slice(0, 80),
    weightKg: text(piece?.weightKg).trim(),
    lengthCm: text(piece?.lengthCm).trim(),
    widthCm: text(piece?.widthCm).trim(),
    heightCm: text(piece?.heightCm).trim(),
    custom: piece?.custom === true || !text(piece?.productCode).trim(),
    boxCode: text(piece?.boxCode).trim(),
  })).filter((piece) => piece.weightKg && piece.lengthCm && piece.widthCm && piece.heightCm);
}

function pieceKey(pieces: TemplatePiece[]): string {
  return pieces
    .map((piece) => [piece.title, piece.productCode, piece.weightKg, piece.lengthCm, piece.widthCm, piece.heightCm, piece.custom ? '1' : '0'].join('|'))
    .sort()
    .join('\n');
}

function cleanTags(value: unknown): string[] {
  const tags = asList<unknown>(value).map((tag) => text(tag).trim()).filter(Boolean);
  return [...new Set(tags)].slice(0, 12);
}

async function tagsForProducts(codes: string[]) {
  const ranges = await query(`SELECT product_range, product_label, match_rules FROM box_size_requirements ORDER BY sort_order, product_range`);
  const families = new Set<string>(FAMILY_RULES.map((rule) => rule[1]));
  const types = new Set<string>();
  for (const row of ranges.rows as { product_range: string; product_label: string }[]) {
    if (row.product_range) families.add(row.product_range);
    if (row.product_label) types.add(row.product_label);
  }
  const suggested = new Set<string>();
  if (codes.length) {
    const products = await query(
      `SELECT DISTINCT product_handle, product_title
         FROM wms_products
        WHERE upper(variant_sku) = ANY($1::text[])
           OR EXISTS (SELECT 1 FROM unnest($1::text[]) code WHERE upper(variant_sku) LIKE code || '-%')`,
      [codes]
    );
    for (const product of products.rows as { product_handle: string | null; product_title: string | null }[]) {
      const handle = String(product.product_handle || '');
      const title = String(product.product_title || '');
      const family = familyFromHandle(handle);
      if (family) suggested.add(family);
      const variant = { title, handle, width_mm: null as number | null };
      for (const row of ranges.rows as { product_range: string; product_label: string; match_rules: { field?: string; contains?: string; width_mm?: number }[] }[]) {
        const rules = Array.isArray(row.match_rules) ? row.match_rules : [];
        const matched = rules.some((rule) => {
          const haystack = (rule.field === 'handle' ? handle : title).toLowerCase();
          if (!haystack.includes(String(rule.contains || '').toLowerCase())) return false;
          return rule.width_mm == null || variant.width_mm === rule.width_mm;
        });
        if (!matched) continue;
        if (row.product_range) suggested.add(row.product_range);
        if (row.product_label) suggested.add(row.product_label);
      }
    }
  }
  return {
    suggested: [...suggested],
    options: [
      ...[...families].sort().map((label) => ({ group: 'Family', label })),
      ...[...types].sort().map((label) => ({ group: 'Type', label })),
    ],
  };
}

router.get('/templates', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const codes = codesFromQuery(req.query.codes);
    const tags = await tagsForProducts(codes);
    if (!codes.length) return res.json({ templates: [], tagOptions: tags.options, suggestedTags: [] });
    const found = await query(
      `SELECT id, name, product_code, tags, pieces, updated_at
         FROM booking_templates
        WHERE upper(product_code) = ANY($1::text[])
           OR ($2::text[] <> '{}' AND tags ?| $2::text[])
        ORDER BY updated_at DESC`,
      [codes, tags.suggested]
    );
    return res.json({ templates: found.rows, tagOptions: tags.options, suggestedTags: tags.suggested });
  } catch (error) {
    console.error('Booking templates failed', error instanceof Error ? error.message : 'query failed');
    return res.status(500).json({ error: 'Could not load templates' });
  }
});

router.post('/templates', authMiddleware, async (req: AuthRequest, res: Response) => {
  const productCode = text(req.body?.productCode).trim().toUpperCase();
  const pieces = cleanPieces(req.body?.pieces);
  if (!productCode) return res.status(400).json({ error: 'A product code is required' });
  if (!pieces.length) return res.status(400).json({ error: 'Add at least one box' });
  const name = text(req.body?.name).trim().slice(0, 160) || pieces.map((piece) => piece.title || 'Extra box').join(' + ').slice(0, 160);
  const tags = cleanTags(req.body?.tags);
  try {
    const existing = await query(
      `SELECT id, name, product_code, tags, pieces, updated_at
         FROM booking_templates WHERE upper(product_code) = $1`,
      [productCode]
    );
    const same = (existing.rows as { pieces: TemplatePiece[] }[]).find((row) => pieceKey(cleanPieces(row.pieces)) === pieceKey(pieces));
    if (same) return res.json({ template: same, created: false });
    const saved = await query(
      `INSERT INTO booking_templates (name, product_code, tags, pieces)
       VALUES ($1, $2, $3::jsonb, $4::jsonb)
       RETURNING id, name, product_code, tags, pieces, updated_at`,
      [name, productCode, JSON.stringify(tags), JSON.stringify(pieces)]
    );
    return res.status(201).json({ template: saved.rows[0], created: true });
  } catch (error) {
    console.error('Save booking template failed', error instanceof Error ? error.message : 'query failed');
    return res.status(500).json({ error: 'Could not save the template' });
  }
});

router.patch('/templates/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  const id = text(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Unknown template' });
  const name = req.body?.name != null ? text(req.body.name).trim().slice(0, 160) : null;
  const tags = req.body?.tags != null ? cleanTags(req.body.tags) : null;
  if (!name && !tags) return res.status(400).json({ error: 'Nothing to change' });
  try {
    const saved = await query(
      `UPDATE booking_templates
          SET name = COALESCE($2, name),
              tags = COALESCE($3::jsonb, tags),
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, name, product_code, tags, pieces, updated_at`,
      [id, name || null, tags ? JSON.stringify(tags) : null]
    );
    if (!saved.rows[0]) return res.status(404).json({ error: 'Unknown template' });
    return res.json({ template: saved.rows[0] });
  } catch (error) {
    console.error('Update booking template failed', error instanceof Error ? error.message : 'query failed');
    return res.status(500).json({ error: 'Could not update the template' });
  }
});

export default router;
