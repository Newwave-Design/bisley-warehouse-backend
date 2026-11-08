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
      plannedDespatchDate: new Date().toISOString(),
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

export async function fetchRoyalMailLabelPdf(orderIdentifiers: number[]): Promise<Buffer> {
  const ids = [...new Set(orderIdentifiers.filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) throw new RoyalMailError('There is no Royal Mail postage to print.');
  if (ids.length > 100) throw new RoyalMailError('Print at most 100 Royal Mail labels at a time.');
  const response = await royalMail(
    `/orders/${ids.join(';')}/label?documentType=postageLabel&includeReturnsLabel=false`,
    { headers: { Accept: 'application/pdf' } },
  );
  if (!response.ok) {
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

export async function deleteRoyalMailOrders(orderIdentifiers: number[]): Promise<void> {
  const ids = [...new Set(orderIdentifiers.filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) return;
  const response = await royalMail(`/orders/${ids.join(';')}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    const payload = await response.json().catch(() => null);
    throw new RoyalMailError(errorText(payload, `Royal Mail did not cancel the postage (${response.status}).`));
  }
}
