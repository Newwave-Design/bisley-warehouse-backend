/**
 * DX Freight DM6 Lite. Book collection creates a consignment for the chosen
 * manifest date, one content line per box, and prints DX's own label.
 * Release is not called: the manifest date is sent with the consignment.
 */

import { isWorkingDay } from './working-days.js';

const LIVE_URL = 'https://dm6api.dxfreight.co.uk/DespatchManager.API.Service.DM6Lite/DM6LiteService.svc';
const FALLBACK_PHONE = '01873900095';

/** One person, up to 50kg, longest side up to 6 metres. Timed services are the same size. */
const DX_MAX_WEIGHT_KG = 50;
const DX_MAX_LENGTH_CM = 600;

const SERVICES: { code: string; name: string; deliveryDays: number; saturday: boolean; preferred: boolean }[] = [
  { code: '48', name: '48 hour', deliveryDays: 2, saturday: false, preferred: true },
  { code: 'ON', name: 'Next day', deliveryDays: 1, saturday: false, preferred: false },
  { code: '3D', name: '72 hour', deliveryDays: 3, saturday: false, preferred: false },
  { code: '930', name: 'Next day by 9:30', deliveryDays: 1, saturday: false, preferred: false },
  { code: 'AM', name: 'Next day by noon', deliveryDays: 1, saturday: false, preferred: false },
  { code: 'SAT', name: 'Saturday', deliveryDays: 0, saturday: true, preferred: false },
  { code: 'S93', name: 'Saturday 9:30', deliveryDays: 0, saturday: true, preferred: false },
];

export class DxError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface DxPiece {
  title: string;
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

export interface DxDelivery {
  name: string;
  company: string;
  email: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  county: string;
  postcode: string;
}

export interface DxBooked {
  consignmentNumber: string;
  routingStream: string;
  serviceCode: string;
  serviceDescription: string;
  trackingNumbers: string[];
  collectionDate: string;
}

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
  totalCost: null;
  currency: string;
}

let sessionCache: { key: string; until: number } | null = null;

export function dxConfigured(): boolean {
  return Boolean(process.env.DX_ACCOUNT_NUMBER && process.env.DX_DEPOT && process.env.DX_PASSWORD);
}

function account() {
  const accountNumber = text(process.env.DX_ACCOUNT_NUMBER);
  const depot = text(process.env.DX_DEPOT);
  const password = text(process.env.DX_PASSWORD);
  const base = (text(process.env.DX_API_URL) || LIVE_URL).replace(/\/$/, '');
  if (process.env.WAREHOUSE_ENV === 'staging') {
    let host = '';
    try { host = new URL(base).hostname.toLowerCase(); } catch { host = ''; }
    if (host !== 'uat-dm.dxdelivery.com') throw new DxError('Staging can only book DX on the UAT service');
  }
  if (!accountNumber || !depot || !password) throw new DxError('DX login is not configured');
  return { accountNumber, depot, password, base };
}

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
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

function atLondonNoon(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function shift(parts: { year: number; month: number; day: number }, days: number) {
  return londonParts(atLondonNoon(parts.year, parts.month, parts.day + days));
}

function formatDmy(parts: { year: number; month: number; day: number }): string {
  return `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')}/${parts.year}`;
}

function parseDmy(value: string): { year: number; month: number; day: number; weekday: string } | null {
  const match = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const stamped = londonParts(atLondonNoon(year, month, day));
  if (stamped.year !== year || stamped.month !== month || stamped.day !== day) return null;
  return stamped;
}

function dateKey(parts: { year: number; month: number; day: number }): number {
  return parts.year * 10000 + parts.month * 100 + parts.day;
}

function addWeekdays(parts: { year: number; month: number; day: number; weekday: string }, count: number) {
  let cursor = parts;
  let left = count;
  while (left > 0) {
    cursor = shift(cursor, 1);
    if (isWorkingDay(cursor)) left -= 1;
  }
  return cursor;
}

function comingSaturday(parts: { year: number; month: number; day: number; weekday: string }) {
  let cursor = parts;
  for (let i = 0; i < 7; i += 1) {
    cursor = shift(cursor, 1);
    if (cursor.weekday === 'Sat') return cursor;
  }
  return shift(parts, 1);
}

/** Weekdays DX can collect. Same day closes at 13:00, which is the Newport depot cutoff. */
export function dxCollectionDays(now = new Date(), count = 4) {
  const today = londonParts(now);
  const pastCutoff = today.hour > 13 || (today.hour === 13 && today.minute > 0);
  const start = isWorkingDay(today) && !pastCutoff ? today : nextWeekday(today);
  const days = [start];
  let cursor = start;
  while (days.length < count) {
    cursor = nextWeekday(cursor);
    days.push(cursor);
  }
  return days;
}

function nextWeekday(parts: { year: number; month: number; day: number; weekday: string }) {
  let cursor = parts;
  do {
    cursor = shift(cursor, 1);
  } while (!isWorkingDay(cursor));
  return cursor;
}

function servicesFor(day: { year: number; month: number; day: number; weekday: string }): QuotedService[] {
  const collectionDate = formatDmy(day);
  return SERVICES.filter((service) => !service.saturday || day.weekday === 'Fri').map((service) => {
    const delivery = service.saturday ? comingSaturday(day) : addWeekdays(day, service.deliveryDays);
    return {
      code: service.code,
      name: service.name,
      carrier: 'DX',
      ruleMatch: service.preferred,
      ruleName: service.name,
      itemType: 'Carton',
      tracked: true,
      signed: false,
      collectionDate,
      estimatedDeliveryDate: formatDmy(delivery),
      latestBooking: '',
      totalCost: null,
      currency: 'GBP',
    };
  });
}

export function dxBoxesFit(pieces: { weightKg: number; lengthCm: number; widthCm: number; heightCm: number }[]): boolean {
  return pieces.length > 0 && pieces.every((piece) => {
    const weight = Number(piece.weightKg);
    const longest = Math.max(Number(piece.lengthCm), Number(piece.widthCm), Number(piece.heightCm));
    return weight > 0 && weight <= DX_MAX_WEIGHT_KG && longest > 0 && longest <= DX_MAX_LENGTH_CM;
  });
}

export function quoteDxCollection(input: {
  pieces: number | { weightKg: number; lengthCm: number; widthCm: number; heightCm: number }[];
  collectionPostcode: string;
  deliveryPostcode: string;
  collectionDate?: string;
  now?: Date;
}) {
  const boxes = Array.isArray(input.pieces) ? input.pieces : [];
  if (boxes.length && !dxBoxesFit(boxes)) {
    throw new DxError('No DX service fits this box. DX takes one-person items up to 50 kg and 6 m.');
  }
  const pieceCount = Array.isArray(input.pieces) ? input.pieces.length : input.pieces;
  const requested = input.collectionDate ? parseDmy(input.collectionDate) : null;
  if (input.collectionDate && !requested) throw new DxError('Choose a collection date');
  if (requested && !isWorkingDay(requested)) throw new DxError('DX collects on a working day, not a weekend or bank holiday');
  const today = londonParts(input.now || new Date());
  if (requested && dateKey(requested) < dateKey(today)) throw new DxError('That collection date has passed');

  const days = requested ? [requested] : dxCollectionDays(input.now);
  const collectionDates = days.map((day) => ({ date: formatDmy(day), services: servicesFor(day) }));
  return {
    booked: false,
    pieces: pieceCount,
    collectionPostcode: input.collectionPostcode,
    deliveryPostcode: input.deliveryPostcode,
    collectionDate: collectionDates[0]?.date || '',
    collectionDates,
    message: null,
    services: collectionDates[0]?.services || [],
  };
}

export function dxReference(value: string): string {
  const clean = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return clean || 'ORDER';
}

/**
 * Printed as ITEM REF on the Zebra label. The strip holds 32 characters
 * between the barcode and the top rule. A longer desk title drops the
 * "MultiDesk" word so the SKU and finish stay on the label.
 * The PDF line stays "Carton (KG)", which is the package type.
 */
function dxAscii(value: string): string {
  return value
    .replace(/\u00b7/g, ' ')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/[\^~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function dxContentDescription(title: string): string {
  const clean = dxAscii(title)
  if (!clean) return 'Carton'
  if (clean.length <= 32) return clean
  const withoutDesk = clean.replace(/^MultiDesk(?: \d+)? /, '')
  return (withoutDesk || clean).slice(0, 32)
}

/** AddCollection rejects DescriptionOfGoods over 30 characters. The label line allows 32. */
export function dxGoodsDescription(title: string): string {
  return dxContentDescription(title || 'Furniture').slice(0, 30)
}

/** UK national number, or blank when the value is not a usable phone. */
export function ukPhone(value: string): string {
  let digits = String(value || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+44')) digits = digits.slice(3);
  else if (digits.startsWith('0044')) digits = digits.slice(4);
  else if (digits.startsWith('44') && digits.length >= 12) digits = digits.slice(2);
  digits = digits.replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length < 9 || digits.length > 10) return '';
  return `0${digits}`;
}

export function dxPhone(value: string): string {
  return ukPhone(value) || FALLBACK_PHONE;
}

/** The customer's number on the order. A number typed on the desk is used only when the order has none. */
export function collectionPhone(orderPhone: string, typedPhone: string): string {
  return ukPhone(orderPhone) || ukPhone(typedPhone) || FALLBACK_PHONE;
}

function clipWords(value: string, max: number): string[] {
  const words = value.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const piece = word.length > max ? word.slice(0, max) : word;
    if (!current) current = piece;
    else if (`${current} ${piece}`.length <= max) current = `${current} ${piece}`;
    else {
      lines.push(current);
      current = piece;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function packAddress(delivery: DxDelivery) {
  const limits = [25, 30, 30, 30, 30];
  const source = [delivery.line1, delivery.line2, delivery.city, delivery.county].filter(Boolean).join(', ');
  const words = source.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let current = '';
  let limit = limits[0];
  for (const word of words) {
    const piece = word.length > limit ? word.slice(0, limit) : word;
    if (!current) current = piece;
    else if (`${current} ${piece}`.length <= limit) current = `${current} ${piece}`;
    else {
      lines.push(current);
      if (lines.length >= limits.length) break;
      limit = limits[lines.length];
      current = piece.slice(0, limit);
    }
  }
  if (current && lines.length < limits.length) lines.push(current);
  return lines;
}

function dxDate(value: string): string {
  const parsed = parseDmy(value);
  if (!parsed) throw new DxError('Choose a collection date');
  return `/Date(${Date.UTC(parsed.year, parsed.month - 1, parsed.day, 12)}+0000)/`;
}

function kg(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(1, Math.round(value));
}

function cm(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(999, Math.round(value));
}

async function call(path: string, body: unknown, session?: string): Promise<any> {
  const { base } = account();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (session) headers.AuthHeader = `<AuthHeader><SessionKey>${session}</SessionKey></AuthHeader>`;
  // A booking that got no reply, or a reply we cannot read, may still exist at DX.
  const creates = path === 'AddConsignment' || path === 'AddCollection';
  const unsure = 'DX did not give a clear reply. Check DX for this order before booking it again.';
  let response: Response;
  let raw: string;
  try {
    response = await fetch(`${base}/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    raw = await response.text();
  } catch {
    throw new DxError(creates ? unsure : 'Could not reach DX.', 502);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new DxError(creates ? unsure : 'DX did not return a readable reply', 502);
  }
}

async function sessionKey(): Promise<string> {
  if (sessionCache && sessionCache.until > Date.now()) return sessionCache.key;
  const { accountNumber, depot, password } = account();
  const json = await call('GetSessionKey', { DXAccountNumber: accountNumber, OrigServiceCentre: depot, Password: password });
  if (json?.Status !== 0 || !json.SessionKey) throw new DxError(text(json?.StatusMessage) || 'DX login failed', 502);
  sessionCache = { key: String(json.SessionKey), until: Date.now() + 20 * 60 * 1000 };
  return sessionCache.key;
}

async function authed(path: string, body: unknown): Promise<any> {
  let json = await call(path, body, await sessionKey());
  if (json?.Status === 4) {
    sessionCache = null;
    json = await call(path, body, await sessionKey());
  }
  return json;
}

function assertOk(json: any, fallback: string) {
  if (json?.Status === 0) return;
  throw new DxError(text(json?.StatusMessage) || fallback, 502);
}

export async function addDxConsignment(input: {
  reference: string;
  serviceCode: string;
  collectionDate: string;
  delivery: DxDelivery;
  pieces: DxPiece[];
}): Promise<DxBooked> {
  const service = SERVICES.find((entry) => entry.code === input.serviceCode);
  if (!service) throw new DxError('Choose a DX service');
  const day = parseDmy(input.collectionDate);
  if (!day || !isWorkingDay(day)) throw new DxError('DX collects on a working day, not a weekend or bank holiday');
  if (service.saturday && day.weekday !== 'Fri') throw new DxError('Saturday delivery is collected on Friday');
  const today = londonParts();
  if (dateKey(day) < dateKey(today)) throw new DxError('That collection date has passed');
  if (!input.pieces.length) throw new DxError('Add at least one box');
  if (!dxBoxesFit(input.pieces)) throw new DxError('No DX service fits this box. DX takes one-person items up to 50 kg and 6 m.');

  const postcode = input.delivery.postcode.toUpperCase().replace(/\s+/g, ' ').trim();
  if (/^BT/i.test(postcode)) throw new DxError('Northern Ireland needs a customs declaration before DX can book it');
  if (postcode.length < 5 || postcode.length > 8) throw new DxError('DX needs a UK postcode');

  const address = packAddress(input.delivery);
  if (!address[0]) throw new DxError('This order needs a street before it can be booked');
  const name = clipWords(input.delivery.company || input.delivery.name, 25)[0] || '';
  const contact = clipWords(input.delivery.name || name, 25)[0] || name;
  if (!name || !contact) throw new DxError('This order needs a name before it can be booked');

  const { accountNumber, depot } = account();
  const contents = input.pieces.map((piece) => ({
    ContentDescription: dxContentDescription(piece.title),
    ContentDescriptionID: 1,
    ContentDimension1: cm(piece.heightCm),
    ContentDimension2: cm(piece.widthCm),
    ContentDimension3: cm(piece.lengthCm),
    ContentQuantity: 1,
    ContentTotalWeight: kg(piece.weightKg),
  }));
  const json = await authed('AddConsignment', {
    BookInFlag: false,
    ConsignmentReference1: dxReference(input.reference),
    Contents: contents,
    DXAccountNumber: accountNumber,
    DeliveryName: name,
    DeliveryAddress1: address[0],
    DeliveryAddress2: address[1] || '',
    DeliveryAddress3: address[2] || '',
    DeliveryAddress4: address[3] || '',
    DeliveryAddress5: address[4] || '',
    DeliveryContact: contact,
    DeliveryEmail: input.delivery.email.slice(0, 100),
    DeliveryPhoneNumber: dxPhone(input.delivery.phone),
    DeliveryPostcode: postcode,
    InsuranceValue: 0,
    ManifestDate: dxDate(input.collectionDate),
    OrigServiceCentre: depot,
    PrivateAddress: !input.delivery.company,
    ServiceCode: service.code,
  });
  if (json?.Status !== 0 || !json.ConsignmentNumber) {
    throw new DxError(text(json?.StatusMessage) || 'DX did not accept the collection. Nothing was saved.', 502);
  }

  const trackingNumbers = (Array.isArray(json.TrackingNumbers) ? json.TrackingNumbers : [])
    .map((entry: { TrackingNumber?: string }) => text(entry?.TrackingNumber))
    .filter(Boolean);
  const consignmentNumber = text(json.ConsignmentNumber);
  const routingStream = text(json.RoutingStream) || 'F';
  if (trackingNumbers.length !== input.pieces.length) {
    await deleteDxConsignment(consignmentNumber, routingStream).catch(() => undefined);
    throw new DxError(trackingNumbers.length
      ? `DX created ${consignmentNumber} but returned ${trackingNumbers.length} labels for ${input.pieces.length} boxes. It has been removed. Book it again.`
      : `DX created ${consignmentNumber} without a tracking number for each box. It has been removed. Book it again.`, 502);
  }

  return {
    consignmentNumber,
    routingStream,
    serviceCode: text(json.ServiceCode) || service.code,
    serviceDescription: text(json.ServiceDescription) || service.name,
    trackingNumbers,
    collectionDate: formatDmy(day),
  };
}

const WAREHOUSE_DELIVERY: DxDelivery = {
  name: 'Ovara Products',
  company: 'Ovara Products Limited',
  email: '',
  phone: FALLBACK_PHONE,
  line1: 'Unit B7A, Brecon House',
  line2: 'Mamhilad Park Estate',
  city: 'Pontypool',
  county: 'Torfaen',
  postcode: 'NP4 0HZ',
};

function dxInstant(value: string, hour: number): string {
  const parsed = parseDmy(value);
  if (!parsed) throw new DxError('Choose a collection date');
  return `/Date(${Date.UTC(parsed.year, parsed.month - 1, parsed.day, hour)}+0000)/`;
}

function dxAccepted(json: any): boolean {
  return json?.Status === 0 || json?.Status === 'Success';
}

function responseDay(value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  const ms = raw.match(/\/Date\((-?\d+)/);
  const date = ms ? new Date(Number(ms[1])) : new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  return formatDmy(londonParts(date));
}

/** Collect a return from the customer and deliver it to the warehouse. */
export async function addDxCollection(input: {
  reference: string;
  serviceCode: string;
  collectionDate: string;
  collection: DxDelivery;
  /** Where it is delivered. The warehouse when left out. */
  delivery?: DxDelivery;
  /** A phone or email for the delivery end, over whichever address it is. */
  deliveryContact?: { phone?: string; email?: string };
  pieces: DxPiece[];
}): Promise<DxBooked> {
  const base = input.delivery || WAREHOUSE_DELIVERY;
  const dest: DxDelivery = { ...base, ...(input.deliveryContact?.phone ? { phone: input.deliveryContact.phone } : {}), ...(input.deliveryContact?.email ? { email: input.deliveryContact.email } : {}) };
  const service = SERVICES.find((entry) => entry.code === input.serviceCode);
  if (!service) throw new DxError('Choose a DX service');
  const day = parseDmy(input.collectionDate);
  if (!day || !isWorkingDay(day)) throw new DxError('DX collects on a working day, not a weekend or bank holiday');
  if (dateKey(day) < dateKey(londonParts())) throw new DxError('That collection date has passed');
  if (!input.pieces.length) throw new DxError('Add at least one box');
  if (!dxBoxesFit(input.pieces)) throw new DxError('No DX service fits this box. DX takes one-person items up to 50 kg and 6 m.');

  const postcode = input.collection.postcode.toUpperCase().replace(/\s+/g, ' ').trim();
  if (/^BT/i.test(postcode)) throw new DxError('Northern Ireland needs a customs declaration before DX can collect it');
  if (postcode.length < 5 || postcode.length > 8) throw new DxError('DX needs a UK postcode');
  const from = packAddress(input.collection);
  const to = packAddress(dest);
  const name = clipWords(input.collection.company || input.collection.name, 25)[0] || '';
  const contact = clipWords(input.collection.name || name, 25)[0] || name;
  if (!from[0] || !name || !contact) throw new DxError('This order needs a name and street before it can be booked');

  const { accountNumber, depot } = account();
  const weight = input.pieces.reduce((sum, piece) => sum + kg(piece.weightKg), 0);
  const json = await authed('AddCollection', {
    CloseTime: dxInstant(input.collectionDate, 17),
    CollectionAddress1: dxAscii(from[0] || '').slice(0, 25),
    CollectionAddress2: dxAscii(from[1] || '').slice(0, 30),
    CollectionAddress3: dxAscii(from[2] || '').slice(0, 30),
    CollectionAddress4: dxAscii(from[3] || '').slice(0, 30),
    CollectionAddress5: dxAscii(from[4] || '').slice(0, 30),
    CollectionContact: dxAscii(contact).slice(0, 25),
    CollectionCountry: 'GB',
    CollectionDate: dxInstant(input.collectionDate, 12),
    CollectionEmail: dxAscii(input.collection.email).slice(0, 50),
    CollectionName: dxAscii(name).slice(0, 25),
    CollectionPhoneNumber: dxPhone(input.collection.phone),
    CollectionPostcode: postcode,
    CollectionReference: dxReference(input.reference),
    DXAccountNumber: accountNumber,
    // CF delivers this collection to the delivery address below (the warehouse unless another was given). CT would send it to the DX depot instead.
    DeliverTo: 'CF',
    DeliveryAddress1: dxAscii(to[0] || '').slice(0, 25),
    DeliveryAddress2: dxAscii(to[1] || '').slice(0, 30),
    DeliveryAddress3: dxAscii(to[2] || '').slice(0, 30),
    DeliveryAddress4: dxAscii(to[3] || '').slice(0, 30),
    DeliveryAddress5: dxAscii(to[4] || '').slice(0, 30),
    DeliveryContact: dxAscii(dest.name).slice(0, 25),
    DeliveryCountry: 'GB',
    DeliveryEmail: dxAscii(dest.email || '').slice(0, 50),
    DeliveryName: dxAscii(clipWords(dest.company, 25)[0] || '').slice(0, 25),
    DeliveryPhoneNumber: dxPhone(dest.phone),
    DeliveryPostcode: dest.postcode,
    DeliveryType: 2,
    DescriptionOfGoods: dxGoodsDescription(input.pieces.map((piece) => piece.title).filter(Boolean).join(', ') || 'Furniture'),
    // DX rejects the routing stream "F" here. Kilos is the carton charged by weight; CartonKG is not enabled on this account.
    FreightType: 'Kilos',
    HowPackaged: 'Carton',
    ItemCount: input.pieces.length,
    OrigServiceCentre: depot,
    ReadyTime: dxInstant(input.collectionDate, 9),
    ServiceCode: service.code,
    TotalWeight: weight,
  });
  if (!dxAccepted(json) || !json?.ConsignmentNumber) {
    throw new DxError(text(json?.StatusMessage) || 'DX did not accept the return collection. Nothing was saved.', 502);
  }

  const consignmentNumber = text(json.ConsignmentNumber);
  const bookedDay = responseDay(json.CollectionDate);
  if (bookedDay && bookedDay !== input.collectionDate) {
    await deleteDxConsignment(consignmentNumber, 'F').catch(() => undefined);
    throw new DxError(`DX booked ${bookedDay} instead of the agreed date ${input.collectionDate}. That collection was cancelled. Call the customer and agree another date.`, 409);
  }
  const trackingNumbers = await fetchDxTrackingNumbers(consignmentNumber, 'F').catch(() => [] as string[]);
  return {
    consignmentNumber,
    routingStream: 'F',
    serviceCode: service.code,
    serviceDescription: service.name,
    trackingNumbers,
    collectionDate: input.collectionDate,
  };
}

export async function fetchDxTrackingNumbers(consignmentNumber: string, routingStream: string): Promise<string[]> {
  const json = await authed('GetConsignmentTrackingInfo', {
    ConsignmentNumber: consignmentNumber,
    RoutingStream: routingStream || 'F',
  });
  assertOk(json, 'DX did not return a tracking number.');
  const numbers = (Array.isArray(json?.TrackingNumbers) ? json.TrackingNumbers : [])
    .map((entry: { TrackingNumber?: string }) => text(entry?.TrackingNumber))
    .filter(Boolean);
  return numbers;
}

/** One delivery event from DX: when, its status code, who signed, and references to the signature image and the driver's photos. */
export interface DxTrackingEvent {
  at: string | null;
  status: string;
  podName: string | null;
  podAt: string | null;
  signatureRef: string | null;
  photoRefs: string[];
  gps: { lat: number; lng: number } | null;
}

function dxEventDate(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  // DX can answer in WCF form, /Date(1700000000000+0000)/, or as an ISO string.
  const wcf = raw.match(/\/Date\((-?\d+)/);
  const date = wcf ? new Date(Number(wcf[1])) : new Date(raw);
  return Number.isNaN(date.getTime()) || date.getUTCFullYear() < 2000 ? null : date.toISOString();
}

/** Read DX's events for a consignment, without logging in again for each call. Proof of delivery is on the delivered event. */
export function dxTrackingEvents(json: any): DxTrackingEvent[] {
  const list = Array.isArray(json?.TrackingEvents) ? json.TrackingEvents : Array.isArray(json?.GetTrackingResult?.TrackingEvents) ? json.GetTrackingResult.TrackingEvents : [];
  return list.map((event: any) => {
    const lat = Number(event?.DeliveryGPSCoOrds?.Latitude ?? event?.DeliveryGPSCoOrds?.Lat);
    const lng = Number(event?.DeliveryGPSCoOrds?.Longitude ?? event?.DeliveryGPSCoOrds?.Long ?? event?.DeliveryGPSCoOrds?.Lng);
    return {
      at: dxEventDate(event?.TrackingEventDateTime),
      status: text(event?.EventStatusCode),
      podName: text(event?.PODName) || null,
      podAt: dxEventDate(event?.PODDateTime),
      signatureRef: text(event?.PODImageAttachmentRef) || null,
      photoRefs: (Array.isArray(event?.DeliveryPhotoAttachmentRefs) ? event.DeliveryPhotoAttachmentRefs : []).map((ref: unknown) => text(ref)).filter(Boolean),
      gps: Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0) ? { lat, lng } : null,
    };
  });
}

export async function fetchDxTracking(consignmentNumber: string): Promise<DxTrackingEvent[]> {
  const json = await authed('GetTracking', { ConsignmentNumber: consignmentNumber });
  assertOk(json, 'DX did not return the tracking for this consignment.');
  return dxTrackingEvents(json);
}

/** One attachment (signature image or delivery photo). DX sends the file as base64 with its type. */
export async function fetchDxAttachment(ref: string): Promise<{ contentType: string; bytes: Buffer } | null> {
  const json = await authed('GetTrackingAttachment', { AttachmentRef: ref });
  assertOk(json, 'DX did not return that delivery image.');
  const data = text(json?.Data);
  if (!data) return null;
  const bytes = Buffer.from(data, 'base64');
  const declared = text(json?.Type).toLowerCase();
  const contentType = declared.includes('/') ? declared
    : /png/.test(declared) || bytes.subarray(1, 4).toString() === 'PNG' ? 'image/png'
    : /gif/.test(declared) || bytes.subarray(0, 3).toString() === 'GIF' ? 'image/gif'
    : 'image/jpeg';
  return { contentType, bytes };
}

export async function deleteDxConsignment(consignmentNumber: string, routingStream: string) {
  const json = await authed('DeleteConsignment', {
    ConsignmentNumber: consignmentNumber,
    RoutingStream: routingStream || 'F',
  });
  if (json?.Status === 0) return;
  const message = text(json?.StatusMessage);
  if (/not found|already deleted|historic/i.test(message)) return;
  throw new DxError(message || 'DX did not cancel the collection. It is still booked here.', 502);
}

function splitZpl(base64: string): string[] {
  const zpl = Buffer.from(base64, 'base64').toString('latin1').replace(/\^XA\s*\^MCY\s*\^XZ/g, '').trim();
  const parts = zpl.split(/(?=\^XA)/).map((part) => part.trim()).filter((part) => part.includes('^XA'));
  if (!parts.length) return [base64];
  return parts.map((part) => Buffer.from(part, 'latin1').toString('base64'));
}

export async function fetchDxLabels(consignmentNumber: string, routingStream: string, format: 'PDF' | 'ZPL', trackingNumbers: string[]) {
  const json = await authed('GetLabels', {
    ConsignmentNumber: consignmentNumber,
    LabelReturnType: format === 'ZPL' ? 1 : 0,
    PDFLabelConfig: { labelSetup: 1, startingPosition: 1 },
    PrintSelection: 2,
    RoutingStream: routingStream || 'F',
  });
  assertOk(json, 'DX did not return the label. Print it again in a few seconds.');
  const encoded = text(json?.label);
  if (!encoded) throw new DxError('DX did not return the label. Print it again in a few seconds.', 502);
  const contents = format === 'ZPL' ? splitZpl(encoded) : [encoded];
  return contents.map((content, index) => ({
    trackingNumber: trackingNumbers[index] || trackingNumbers[0] || consignmentNumber,
    format,
    content,
  }));
}
