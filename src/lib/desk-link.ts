/**
 * The warehouse calling the customer desk: to send a claim from the orders mailbox, and to list who a claim can go to.
 * It signs in with DEMO_AUTH_TOKEN, which the desk already holds as WMS_READ_TOKEN. Staging never calls the live desk,
 * so a test claim can never reach a supplier.
 */
import { isStaging } from './staging.js';
import { buildClaimPack } from './return-claim-pack.js';

const LIVE_DESK = 'https://customer-desk-production-bcb7cfec.up.railway.app';

export class DeskLinkError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function desk() {
  const base = String(process.env.DESK_API_URL || '').trim() || (isStaging() ? '' : LIVE_DESK);
  const token = String(process.env.DEMO_AUTH_TOKEN || '').trim();
  if (!base) throw new DeskLinkError(503, 'Staging does not send claims. Set DESK_API_URL to a test desk to try it.');
  if (isStaging() && base.replace(/\/$/, '') === LIVE_DESK) throw new DeskLinkError(503, 'Staging cannot send claims through the live customer desk.');
  if (!token) throw new DeskLinkError(503, 'The customer desk is not connected (DEMO_AUTH_TOKEN is not set).');
  return { base: base.replace(/\/$/, ''), token };
}

async function readJson(response: Response) {
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new DeskLinkError(response.status, String(data.error || `The customer desk answered ${response.status}`));
  return data;
}

export async function claimContacts(): Promise<{ bisley: string | null; contacts: { company: string; name: string | null; role: string | null; email: string }[] }> {
  const { base, token } = desk();
  const response = await fetch(`${base}/api/warehouse/claim-contacts`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  return await readJson(response) as never;
}

/** The email for a claim: a short covering note, then the claim written out. */
export function claimEmail(pack: { kind: 'bisley' | 'carrier'; rma: string; order: string; customer: string; consignment: string; text: string }, message: string) {
  const subject = pack.kind === 'carrier'
    ? `Damage claim ${pack.rma}: consignment ${pack.consignment || 'unknown'}, order ${pack.order}`
    : `Damage claim ${pack.rma}: order ${pack.order}, ${pack.customer}`;
  const opening = message.trim() || (pack.kind === 'carrier'
    ? 'Please find our claim for goods damaged in transit below. The photos are attached, starting with your driver\'s delivery photo.'
    : 'Please find our claim for a manufacturing fault below. The photos are attached.');
  return { subject: subject.slice(0, 250), body: `${opening}\n\n${pack.text}` };
}

export async function sendClaim(claimId: string, to: string, message: string): Promise<{ to: string[]; photos: number; photosLeftOut: number }> {
  const pack = await buildClaimPack(claimId);
  if (!pack) throw new DeskLinkError(404, 'Claim not found');
  const { base, token } = desk();
  const mail = claimEmail(pack, message);
  // The mailbox takes about 2.8 MB of photos. The desk keeps them in this order and drops what does not fit.
  const photos = pack.photoFiles.map((file) => ({ name: file.name, content_type: file.contentType, data_base64: file.data.toString('base64') }));
  const response = await fetch(`${base}/api/warehouse/claim-mail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, subject: mail.subject, body: mail.body, photos, case_id: pack.deskCaseId }),
    signal: AbortSignal.timeout(90_000),
  });
  const data = await readJson(response);
  const sent = Number(data.photos) || 0;
  return { to: (data.to as string[]) || [], photos: sent, photosLeftOut: Math.max(0, photos.length - sent) };
}
