/**
 * Royal Mail Click & Drop for sample post.
 * Create orders, print postage labels, then manifest them onto the collection.
 * https://api.parcel.royalmail.com/api/v1
 */

const BASE = 'https://api.parcel.royalmail.com/api/v1';

export class RoyalMailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoyalMailError';
  }
}

export function royalMailConfigured(): boolean {
  return Boolean(process.env.ROYAL_MAIL_API_KEY?.trim());
}

function authHeader(): string {
  const key = process.env.ROYAL_MAIL_API_KEY?.trim() || '';
  if (!key) throw new RoyalMailError('Royal Mail is not connected. Add the Click & Drop API key.');
  return /^bearer\s+/i.test(key) ? key : `Bearer ${key}`;
}

export function royalMailServiceCode(): string {
  return (process.env.ROYAL_MAIL_SERVICE_CODE || '').trim().slice(0, 10);
}

export type RoyalMailPackageFormat = 'letter' | 'largeLetter';

/** Four samples or fewer post as a letter. More than that is a large letter. */
export function royalMailPackageFormat(sampleCount: number): RoyalMailPackageFormat {
  return Math.max(1, Math.round(Number(sampleCount)) || 1) <= 4 ? 'letter' : 'largeLetter';
}

export function asRoyalMailPackageFormat(value: unknown, sampleCount: number): RoyalMailPackageFormat {
  return value === 'letter' || value === 'largeLetter' ? value : royalMailPackageFormat(sampleCount);
}

export function royalMailSampleWeightGrams(): number {
  const weight = Number(process.env.ROYAL_MAIL_SAMPLE_WEIGHT_GRAMS || 100);
  if (!Number.isFinite(weight)) return 100;
  return Math.min(750, Math.max(1, Math.round(weight)));
}

async function royalMail(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
}

function errorText(payload: any, fallback: string): string {
  const failed = Array.isArray(payload?.failedOrders) ? payload.failedOrders : [];
  const fromOrders = failed.flatMap((row: any) => {
    const errors = Array.isArray(row?.errors) ? row.errors : [];
    return errors.map((error: any) => String(error?.errorMessage || error?.message || '').trim()).filter(Boolean);
  });
  const listed = Array.isArray(payload?.errors)
    ? payload.errors.map((error: any) => String(error?.message || error?.errorMessage || error?.description || '').trim()).filter(Boolean)
    : [];
  const single = String(payload?.message || payload?.error || '').trim();
  return [...fromOrders, ...listed, single].filter(Boolean).join('; ') || fallback;
}

export type RoyalMailOrderInput = {
  orderReference: string;
  recipient: {
    address: {
      fullName: string;
      companyName?: string;
      addressLine1: string;
      addressLine2?: string;
      city: string;
      county?: string;
      postcode: string;
      countryCode: string;
    };
    phoneNumber?: string;
  };
  sampleCount: number;
  packageFormat?: RoyalMailPackageFormat;
};

export type CreatedRoyalMailOrder = {
  orderReference: string;
  orderIdentifier: number;
  trackingNumber: string;
};

export async function createRoyalMailOrders(orders: RoyalMailOrderInput[]): Promise<{
  created: CreatedRoyalMailOrder[];
  failed: { orderReference: string; reason: string }[];
}> {
  const serviceCode = royalMailServiceCode();
  const weight = royalMailSampleWeightGrams();
  const items = orders.map((order) => {
    const quantity = Math.max(1, order.sampleCount || 1);
    const country = order.recipient.address.countryCode || 'GB';
    return {
      orderReference: order.orderReference.slice(0, 40),
      recipient: order.recipient,
      orderDate: new Date().toISOString(),
      subtotal: 0,
      shippingCostCharged: 0,
      total: 0,
      currencyCode: 'GBP',
      packages: [{
        weightInGrams: weight,
        packageFormatIdentifier: asRoyalMailPackageFormat(order.packageFormat, quantity),
        contents: [{
          name: 'Colour finish samples',
          quantity,
          unitValue: country === 'GB' ? 0 : 1,
          unitWeightInGrams: Math.max(1, Math.round(weight / quantity)),
          originCountryCode: 'GB',
          customsDescription: 'Colour finish samples',
          customsDeclarationCategory: country === 'GB' ? 'none' : 'commercialSample',
        }],
      }],
      postageDetails: {
        ...(serviceCode ? { serviceCode } : {}),
        receiveEmailNotification: false,
        receiveSmsNotification: false,
      },
      label: { includeLabelInResponse: false },
    };
  });

  const response = await royalMail('/orders', { method: 'POST', body: JSON.stringify({ items }) });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) {
    throw new RoyalMailError(errorText(payload, `Royal Mail did not accept the orders (${response.status}).`));
  }

  const created = (Array.isArray(payload.createdOrders) ? payload.createdOrders : []).map((row: any) => ({
    orderReference: String(row?.orderReference || '').trim(),
    orderIdentifier: Number(row?.orderIdentifier),
    trackingNumber: String(row?.trackingNumber || row?.packages?.[0]?.trackingNumber || '').trim(),
  })).filter((row: CreatedRoyalMailOrder) => row.orderReference && Number.isFinite(row.orderIdentifier));

  const failed = (Array.isArray(payload.failedOrders) ? payload.failedOrders : []).map((row: any) => ({
    orderReference: String(row?.order?.orderReference || '').trim(),
    reason: (Array.isArray(row?.errors) ? row.errors : [])
      .map((error: any) => String(error?.errorMessage || '').trim())
      .filter(Boolean)
      .join('; ') || 'Royal Mail rejected this order',
  }));

  return { created, failed };
}

const rememberedLabels = new Map<number, Buffer>();

function rememberRoyalMailLabel(orderIdentifier: number, pdf: Buffer) {
  rememberedLabels.set(orderIdentifier, pdf);
  setTimeout(() => rememberedLabels.delete(orderIdentifier), 10 * 60 * 1000);
}

function trackingFrom(row: any): string {
  const packages = Array.isArray(row?.packages) ? row.packages : [];
  return String(row?.trackingNumber || packages.find((piece: any) => piece?.trackingNumber)?.trackingNumber || '').trim();
}

/** Tracking is allocated when the label is created, so a new order can still be empty. */
export async function readRoyalMailTracking(orderIdentifier: number): Promise<string> {
  if (!Number.isFinite(orderIdentifier) || orderIdentifier <= 0) return '';
  const response = await royalMail(`/orders/${orderIdentifier}`);
  const payload: any = await response.json().catch(() => null);
  const rows = Array.isArray(payload?.orders) ? payload.orders : Array.isArray(payload) ? payload : [];
  return trackingFrom(rows[0]);
}

export async function fetchRoyalMailLabelPdf(orderIdentifiers: number[]): Promise<Buffer> {
  const ids = [...new Set(orderIdentifiers.filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) throw new RoyalMailError('There is no Royal Mail postage to print.');
  if (ids.length > 100) throw new RoyalMailError('Print at most 100 Royal Mail labels at a time.');
  const remembered = ids.length === 1 ? rememberedLabels.get(ids[0]) : undefined;
  if (remembered) return remembered;
  const response = await royalMail(
    `/orders/${ids.join(';')}/label?documentType=postageLabel&includeReturnsLabel=false`,
    { headers: { Accept: 'application/pdf' } },
  );
  if (!response.ok) {
    if (response.status === 403) {
      throw new RoyalMailError('This Royal Mail account cannot send the label to the printer. Print it from Click & Drop.');
    }
    const payload = await response.json().catch(() => null);
    throw new RoyalMailError(errorText(payload, `Royal Mail did not return the labels (${response.status}).`));
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function manifestRoyalMail(): Promise<{ manifestNumber: number | null; pdf: string | null }> {
  const response = await royalMail('/manifests', { method: 'POST', body: JSON.stringify({}) });
  const payload = await response.json().catch(() => null);
  if (response.status !== 201 && response.status !== 202) {
    throw new RoyalMailError(errorText(payload, `Royal Mail did not manifest the collection (${response.status}).`));
  }
  const manifestNumber = Number(payload?.manifestNumber);
  const pdf = typeof payload?.documentPdf === 'string' && payload.documentPdf ? payload.documentPdf : null;
  return { manifestNumber: Number.isFinite(manifestNumber) ? manifestNumber : null, pdf };
}

export type RoyalMailParcelFormat = 'letter' | 'largeLetter' | 'smallParcel' | 'mediumParcel' | 'parcel';

type ParcelPiece = { weightKg: number; lengthCm: number; widthCm: number; heightCm: number };

const PARCEL_FORMATS: { id: RoyalMailParcelFormat; query: string; label: string; maxMm: [number, number, number]; maxGrams: number; girthMm?: number }[] = [
  { id: 'letter', query: 'Letter', label: 'Letter', maxMm: [240, 165, 5], maxGrams: 100 },
  { id: 'largeLetter', query: 'LargeLetter', label: 'Large letter', maxMm: [353, 250, 25], maxGrams: 750 },
  { id: 'smallParcel', query: 'SmallParcel', label: 'Small parcel', maxMm: [450, 350, 160], maxGrams: 2000 },
  { id: 'mediumParcel', query: 'MediumParcel', label: 'Medium parcel', maxMm: [610, 460, 460], maxGrams: 20000 },
  { id: 'parcel', query: 'Parcel', label: 'Parcel', maxMm: [1500, 1500, 1500], maxGrams: 30000, girthMm: 3000 },
];

function pieceMm(piece: ParcelPiece): [number, number, number] | null {
  const sides = [piece.lengthCm, piece.widthCm, piece.heightCm]
    .map((value) => Math.round(Number(value) * 10))
    .sort((left, right) => right - left);
  if (sides.some((side) => !Number.isFinite(side) || side < 1)) return null;
  return sides as [number, number, number];
}

function formatFits(piece: ParcelPiece, format: (typeof PARCEL_FORMATS)[number]): boolean {
  const grams = Math.round(Number(piece.weightKg) * 1000);
  if (!Number.isFinite(grams) || grams < 1 || grams > format.maxGrams) return false;
  const sides = pieceMm(piece);
  if (!sides) return false;
  const limits = [...format.maxMm].sort((left, right) => right - left);
  if (sides.some((side, index) => side > limits[index])) return false;
  if (format.girthMm && sides[0] + 2 * (sides[1] + sides[2]) > format.girthMm) return false;
  return true;
}

/** Formats that can take every box, smallest first. A parcel is included when a letter also fits. */
export function royalMailFormatsFor(pieces: ParcelPiece[]) {
  const fitting = PARCEL_FORMATS.filter((format) => pieces.length && pieces.every((piece) => formatFits(piece, format)));
  if (!fitting.length) return [];
  const parcel = fitting.find((format) => format.id === 'smallParcel' || format.id === 'mediumParcel' || format.id === 'parcel');
  const chosen = parcel && parcel !== fitting[0] ? [fitting[0], parcel] : [fitting[0]];
  return chosen;
}

function londonDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(now);
  const read = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
    hour: Number(read('hour')),
    weekday: read('weekday'),
  };
}

function shiftLondon(day: { year: number; month: number; day: number }, days: number) {
  return londonDay(new Date(Date.UTC(day.year, day.month - 1, day.day + days, 12)));
}

function nextWeekday(day: ReturnType<typeof londonDay>) {
  let cursor = day;
  do { cursor = { ...shiftLondon(cursor, 1), hour: 12 }; } while (cursor.weekday === 'Sat' || cursor.weekday === 'Sun');
  return cursor;
}

function stamp(day: { year: number; month: number; day: number }) {
  return `${String(day.day).padStart(2, '0')}/${String(day.month).padStart(2, '0')}/${day.year}`;
}

function addWeekdays(day: ReturnType<typeof londonDay>, count: number) {
  let cursor = day;
  for (let step = 0; step < count; step += 1) cursor = nextWeekday(cursor);
  return stamp(cursor);
}

export type RoyalMailQuotedService = {
  code: string;
  name: string;
  ruleMatch: boolean;
  ruleName: string;
  collectionDate: string;
  estimatedDeliveryDate: string;
  packageFormat: RoyalMailParcelFormat;
};

function listedServices(payload: any): { code: string; name: string }[] {
  const groups = Array.isArray(payload) ? payload : payload ? [payload] : [];
  return groups.flatMap((group: any) => {
    const carrier = String(group?.carrierName || '');
    if (carrier && !/royal mail/i.test(carrier)) return [];
    const rows = Array.isArray(group?.services) ? group.services : [];
    return rows
      .filter((service: any) => {
        const dropOff = service?.dropOffOptions;
        return !Array.isArray(dropOff) || dropOff.includes('Collection');
      })
      .map((service: any) => ({
        code: String(service?.serviceCode || '').trim(),
        name: String(service?.serviceName || '').trim(),
      }))
      .filter((service: { code: string; name: string }) => service.code && service.name && !/return|age verification/i.test(service.name));
  });
}

async function servicesForFormat(postcode: string, format: (typeof PARCEL_FORMATS)[number], weightGrams: number) {
  const olpFormat = format.id === 'parcel' ? 'LargeParcel' : format.query;
  const olp = new URLSearchParams({
    country: 'GBR',
    postcode,
    weight: String(weightGrams),
    packageFormat: olpFormat,
  });
  let response = await royalMail(`/services/olp?${olp.toString()}`);
  let payload: any = await response.json().catch(() => null);
  if (response.status === 403 || response.status === 404) {
    const account = new URLSearchParams({
      destinationCountryCode: 'GBR',
      destinationPostcode: postcode,
      packagingFormat: format.query,
      packageWeight: String(weightGrams),
    });
    response = await royalMail(`/services?${account.toString()}`);
    payload = await response.json().catch(() => null);
  }
  if (!response.ok) {
    throw new RoyalMailError(errorText(payload, `Royal Mail did not return services for this box (${response.status}).`));
  }
  return listedServices(payload);
}

/** Asks Click & Drop which services can take these boxes. Letter is not the only answer. */
export async function quoteRoyalMailParcels(input: { postcode: string; pieces: ParcelPiece[] }): Promise<{
  collectionDate: string;
  collectionDates: { date: string; services: RoyalMailQuotedService[] }[];
  services: RoyalMailQuotedService[];
}> {
  const formats = royalMailFormatsFor(input.pieces);
  if (!formats.length) throw new RoyalMailError('Royal Mail cannot take a box this size or weight.');
  const postcode = input.postcode.trim().toUpperCase();
  const heaviest = Math.max(...input.pieces.map((piece) => Math.round(Number(piece.weightKg) * 1000)));
  const today = londonDay();
  const days = today.weekday === 'Sat' || today.weekday === 'Sun' || today.hour >= 16
    ? [nextWeekday(today)]
    : [today, nextWeekday(today)];
  const offered: RoyalMailQuotedService[] = [];
  for (const format of formats) {
    const found = await servicesForFormat(postcode, format, heaviest);
    const best = format === formats[0];
    for (const service of found) {
      const code = `${service.code}|${format.id}`;
      if (offered.some((row) => row.code === code)) continue;
      offered.push({
        code,
        name: service.name,
        ruleMatch: best,
        ruleName: `${service.name} · ${format.label}`,
        collectionDate: '',
        estimatedDeliveryDate: '',
        packageFormat: format.id,
      });
    }
  }
  if (!offered.length) throw new RoyalMailError('Royal Mail has no service for this box and postcode.');
  const collectionDates = days.map((day) => ({
    date: stamp(day),
    services: offered.map((service) => ({
      ...service,
      collectionDate: stamp(day),
      estimatedDeliveryDate: addWeekdays(day, /24|1pm|9am|next day/i.test(service.name) ? 1 : 2),
    })),
  }));
  return { collectionDate: collectionDates[0].date, collectionDates, services: collectionDates[0].services };
}

export async function createRoyalMailParcel(input: {
  orderReference: string;
  recipient: RoyalMailOrderInput['recipient'];
  serviceCode: string;
  packageFormat: RoyalMailParcelFormat;
  pieces: { title?: string; weightKg: number; lengthCm: number; widthCm: number; heightCm: number }[];
}): Promise<CreatedRoyalMailOrder> {
  const format = PARCEL_FORMATS.find((row) => row.id === input.packageFormat);
  if (!format || !input.pieces.every((piece) => formatFits(piece, format))) {
    throw new RoyalMailError('That Royal Mail service does not fit this box.');
  }
  const serviceCode = input.serviceCode.trim().slice(0, 10);
  if (!serviceCode) throw new RoyalMailError('Choose a Royal Mail service.');
  const country = input.recipient.address.countryCode || 'GB';
  const packages = input.pieces.map((piece) => {
    const grams = Math.min(30000, Math.max(1, Math.round(Number(piece.weightKg) * 1000)));
    const depth = Math.max(1, Math.round(Number(piece.lengthCm) * 10));
    const width = Math.max(1, Math.round(Number(piece.widthCm) * 10));
    const height = Math.max(1, Math.round(Number(piece.heightCm) * 10));
    const name = String(piece.title || 'Replacement part').trim().slice(0, 800) || 'Replacement part';
    return {
      weightInGrams: grams,
      packageFormatIdentifier: format.id,
      dimensions: { heightInMms: height, widthInMms: width, depthInMms: depth },
      contents: [{
        name,
        quantity: 1,
        unitValue: country === 'GB' ? 0 : 1,
        unitWeightInGrams: grams,
        originCountryCode: 'GB',
        customsDescription: name.slice(0, 50),
        customsDeclarationCategory: country === 'GB' ? 'none' : 'sold',
      }],
    };
  });
  const response = await royalMail('/orders', {
    method: 'POST',
    body: JSON.stringify({
      items: [{
        orderReference: input.orderReference.slice(0, 40),
        recipient: input.recipient,
        orderDate: new Date().toISOString(),
        subtotal: 0,
        shippingCostCharged: 0,
        total: 0,
        currencyCode: 'GBP',
        packages,
        postageDetails: {
          serviceCode,
          receiveEmailNotification: false,
          receiveSmsNotification: false,
        },
        label: { includeLabelInResponse: false },
      }],
    }),
  });
  const payload: any = await response.json().catch(() => null);
  if (!response.ok || !payload) {
    throw new RoyalMailError(errorText(payload, `Royal Mail did not accept the parcel (${response.status}).`));
  }
  const row = (Array.isArray(payload.createdOrders) ? payload.createdOrders : [])[0];
  const created = {
    orderReference: String(row?.orderReference || '').trim(),
    orderIdentifier: Number(row?.orderIdentifier),
    trackingNumber: trackingFrom(row),
  };
  const label = typeof row?.label === 'string' ? row.label.replace(/\s+/g, '') : '';
  if (label.startsWith('JVBERi') && Number.isFinite(created.orderIdentifier)) {
    rememberRoyalMailLabel(created.orderIdentifier, Buffer.from(label, 'base64'));
  }
  if (!created.trackingNumber && Number.isFinite(created.orderIdentifier)) {
    created.trackingNumber = await readRoyalMailTracking(created.orderIdentifier);
  }
  if (!created.orderReference || !Number.isFinite(created.orderIdentifier)) {
    const reason = (Array.isArray(payload.failedOrders) ? payload.failedOrders : [])
      .flatMap((failed: any) => (Array.isArray(failed?.errors) ? failed.errors : []).map((error: any) => String(error?.errorMessage || '').trim()))
      .filter(Boolean)
      .join('; ');
    throw new RoyalMailError(reason || 'Royal Mail did not accept the parcel.');
  }
  return created;
}

export async function deleteRoyalMailOrders(orderIdentifiers: number[]): Promise<void> {
  const ids = [...new Set(orderIdentifiers.filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) return;
  const response = await royalMail(`/orders/${ids.join(';')}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    const payload = await response.json().catch(() => null);
    throw new RoyalMailError(errorText(payload, `Royal Mail did not cancel the postage (${response.status}).`));
  }
}
