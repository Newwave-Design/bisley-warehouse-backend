/**
 * When a booked parcel is far enough through the carrier that the customer
 * tracking page works and the parcel is actually on its way.
 *
 * APC's tracking API returns the scan list. Label printed and "at sending depot"
 * are before APC publishes the public page. The page is up once the parcel is at the hub.
 * DX's tracking API only returns event code F00, including after delivery, so the
 * public tracking page is the source of the collection and delivery scans.
 */

export type ApcScan = {
  description: string;
  group?: string;
};

const APC_ON_THE_WAY = new Set([
  'AT HUB',
  'DEPOT SORT SCAN',
  'AT DELIVERY DEPOT',
  'HELD AT DELIVERY DEPOT',
  'OUT FOR DELIVERY',
  'LEFT WITH NEIGHBOUR',
  'DELIVERED',
  'MISSORT - AT INCORRECT DEPOT',
  'NOT RECEIVED ON TRUNK',
  'VEHICLE BREAKDOWN',
]);

const DX_ON_THE_WAY = /scan at (collection|delivery) depot|onto delivery vehicle|out for delivery|delivered|accident\/breakdown/i;

function clean(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function apcOnTheWay(scans: ApcScan[]): boolean {
  return scans.some((scan) => APC_ON_THE_WAY.has(clean(scan.description).toUpperCase()));
}

export function dxOnTheWay(statuses: string[]): boolean {
  return statuses.some((status) => DX_ON_THE_WAY.test(clean(status)));
}

export function dxStatusesFromPage(html: string): string[] {
  const cells = [...html.matchAll(/class="gridText">([^<]*)</g)].map((match) => clean(match[1]));
  const statuses: string[] = [];
  for (let index = 1; index < cells.length; index += 3) {
    if (cells[index]) statuses.push(cells[index]);
  }
  const latest = html.match(/id="_ctl0_FeaturedContent_lbl_status"[^>]*>([^<]*)</)?.[1];
  if (latest) statuses.push(clean(latest));
  return statuses;
}

function apcScans(payload: any): ApcScan[] {
  const track = payload?.Tracks?.Track;
  const row = Array.isArray(track) ? track[0] : track;
  const wrapped = row?.ShipmentDetails?.Items;
  const groups = Array.isArray(wrapped) ? wrapped : wrapped ? [wrapped] : [];
  const items = groups.flatMap((group) => {
    const item = group?.Item || group;
    return Array.isArray(item) ? item : item ? [item] : [];
  });
  return items.flatMap((item) =>
    [].concat(item?.Activity || []).flatMap((entry: any) => {
      const description = clean(entry?.Status?.StatusDescription);
      return description ? [{ description, group: clean(entry?.Status?.StatusGroup) }] : [];
    })
  );
}

async function apcScansFor(waybill: string): Promise<ApcScan[]> {
  const number = waybill.replace(/\s+/g, '');
  const user = process.env.APC_USER;
  const password = process.env.APC_PASSWORD;
  if (!user || !password || !/^\d{22}$/.test(number)) return [];
  const response = await fetch(
    `https://apc.hypaship.com/api/3.0/Tracks/${encodeURIComponent(number)}.json?searchtype=CarrierWaybill&history=Yes`,
    {
      signal: AbortSignal.timeout(12000),
      headers: {
        'remote-user': `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
        Accept: 'application/json',
      },
    }
  );
  if (!response.ok) {
    console.warn(`[tracking] APC status for ${number} returned ${response.status}`);
    return [];
  }
  return apcScans(await response.json());
}

async function dxStatusesFor(consignment: string, postcode: string): Promise<string[]> {
  const number = consignment.replace(/\s+/g, '').toUpperCase();
  const compact = postcode.toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z]\d{7}$|^\d{8}$/.test(number) || compact.length < 5) return [];
  const start = `https://dx-track.com/track/dx.aspx?consno=${encodeURIComponent(number)}&postcode=${encodeURIComponent(compact)}`;
  const headers = { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' };
  const first = await fetch(start, { redirect: 'manual', signal: AbortSignal.timeout(12000), headers });
  let html = '';
  if (first.status >= 300 && first.status < 400 && first.headers.get('location')) {
    const cookie = (first.headers.get('set-cookie') || '').split(';')[0];
    const next = new URL(first.headers.get('location') || start, start);
    const second = await fetch(next, { signal: AbortSignal.timeout(12000), headers: { ...headers, Cookie: cookie } });
    if (!second.ok) {
      console.warn(`[tracking] DX status for ${number} returned ${second.status}`);
      return [];
    }
    html = await second.text();
  } else if (first.ok) {
    html = await first.text();
  } else {
    console.warn(`[tracking] DX status for ${number} returned ${first.status}`);
    return [];
  }
  if (/TrackingError/i.test(html) && !/gridText/.test(html)) return [];
  return dxStatusesFromPage(html);
}

/** True when APC or DX shows the parcel has left the booking stage and is in the delivery network. */
export async function parcelOnItsWay(courier: string, waybill: string, postcode: string): Promise<boolean> {
  const name = clean(courier).toUpperCase();
  try {
    if (name === 'APC') return apcOnTheWay(await apcScansFor(waybill));
    if (name === 'DX') return dxOnTheWay(await dxStatusesFor(waybill, postcode));
  } catch (error) {
    console.warn(`[tracking] ${name} status was not read`, error instanceof Error ? error.message : 'failed');
  }
  return false;
}
