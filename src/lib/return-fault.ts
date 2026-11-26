/**
 * Who is at fault for damage, and when a claim can be raised against them.
 * The outer box decides most cases: a damaged box points at the courier, a sound box with a defect points at the factory.
 * Staff make the call. These rules only stop a claim being raised without the evidence the other side will ask for.
 */
export const FAULTS = ['courier', 'manufacturing', 'packing', 'customer', 'unknown'] as const;
export type Fault = (typeof FAULTS)[number];

/** delivery and signature come from the courier's proof of delivery; staff upload the others. */
export const PHOTO_KINDS = ['item', 'box', 'label', 'inner', 'other', 'delivery', 'signature'] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];

export const WANTS = ['refund', 'replace', 'part_refund', 'repair', 'undecided'] as const;
export type Wants = (typeof WANTS)[number];

export const CLAIM_KINDS = ['carrier', 'bisley'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const CLAIM_STATUSES = ['open', 'sent', 'accepted', 'rejected', 'paid', 'withdrawn'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export function isFault(value: unknown): value is Fault {
  return (FAULTS as readonly string[]).includes(String(value));
}
export function isPhotoKind(value: unknown): value is PhotoKind {
  return (PHOTO_KINDS as readonly string[]).includes(String(value));
}
export function isWants(value: unknown): value is Wants {
  return (WANTS as readonly string[]).includes(String(value));
}
export function isClaimKind(value: unknown): value is ClaimKind {
  return (CLAIM_KINDS as readonly string[]).includes(String(value));
}
export function isClaimStatus(value: unknown): value is ClaimStatus {
  return (CLAIM_STATUSES as readonly string[]).includes(String(value));
}

/** Which claim a fault leads to: the courier is claimed against as the carrier, the factory and its packing as Bisley. */
export function claimKindForFault(fault: string | null | undefined): ClaimKind | null {
  if (fault === 'courier') return 'carrier';
  if (fault === 'manufacturing' || fault === 'packing') return 'bisley';
  return null;
}

export interface ClaimCheck {
  kind: string;
  fault: string | null | undefined;
  photoKinds: (string | null | undefined)[];
  override?: string | null;
  open?: boolean;
}

/** Can this claim be raised now? A typed reason (10 characters or more) lets a claim go without the usual photo. */
export function canRaiseClaim(check: ClaimCheck): { ok: true } | { ok: false; reason: string } {
  if (!isClaimKind(check.kind)) return { ok: false, reason: 'Choose a carrier claim or a Bisley claim.' };
  if (check.open === false) return { ok: false, reason: 'This case is closed.' };
  if (!check.fault || check.fault === 'unknown') return { ok: false, reason: 'Set who is at fault first.' };
  const expected = claimKindForFault(check.fault);
  if (expected !== check.kind) {
    return { ok: false, reason: check.kind === 'carrier' ? 'A carrier claim is for courier damage. Set the fault to Courier first.' : 'A Bisley claim is for a manufacturing or packing fault. Set the fault first.' };
  }
  const overridden = String(check.override || '').trim().length >= 10;
  const kinds = check.photoKinds.map((kind) => String(kind || 'item'));
  if (check.kind === 'carrier' && !kinds.some((kind) => kind === 'box' || kind === 'label') && !overridden) {
    return { ok: false, reason: 'A carrier will ask for a photo of the outer box or label. Add one, or give a reason to claim without it.' };
  }
  // The courier's delivery photo and signature are not a photo of the damage.
  if (!kinds.some((kind) => kind !== 'delivery' && kind !== 'signature') && !overridden) {
    return { ok: false, reason: 'Add a photo of the damage, or give a reason to claim without one.' };
  }
  return { ok: true };
}

const BOX_SOUND = /(box|packaging|carton|parcel)[^.]{0,40}(was|were|is|looked)?\s*(not damaged|undamaged|fine|intact|perfect|in good (condition|shape))|well wrapped|no damage to the (box|packaging)/i;
const BOX_HIT = /(dropped|crushed|forklift|hole in the (box|carton)|(box|packaging|carton|parcel)[^.]{0,30}(damaged|crushed|torn|dented|ripped|smashed|battered)|driver (threw|dropped))/i;

/** A hint from what is on the case. Never sets the fault: staff do that. */
export function suggestFault(input: { reason?: string | null; courier_problem?: string | null; notes?: string | null }): { fault: Fault; why: string } | null {
  const text = String(input.notes || '');
  if (input.courier_problem && input.courier_problem !== 'lost') return { fault: 'courier', why: 'A courier problem was logged on this return.' };
  // A sound box is checked first: "the box was not damaged" would otherwise read as a damaged box.
  if (BOX_SOUND.test(text)) return { fault: 'manufacturing', why: 'The notes say the box arrived sound, so the damage was likely there before it was packed.' };
  if (BOX_HIT.test(text)) return { fault: 'courier', why: 'The notes say the parcel or box was damaged or dropped.' };
  if (/fault/i.test(String(input.reason || ''))) return { fault: 'manufacturing', why: 'The item is reported faulty rather than damaged in transit.' };
  return null;
}

/** What a claim will need, and whether the case has it yet. */
export function evidenceChecklist(input: { photoKinds: (string | null | undefined)[]; reportedAt?: string | Date | null; tracking?: string | null; fault?: string | null }) {
  const kinds = input.photoKinds.map((kind) => String(kind || 'item'));
  return [
    { key: 'item', label: 'Photo of the damage', ok: kinds.some((kind) => kind === 'item' || kind === 'other') },
    { key: 'box', label: 'Photo of the outer box', ok: kinds.includes('box') },
    { key: 'label', label: 'Photo of the shipping label', ok: kinds.includes('label') },
    { key: 'delivery', label: "Courier's delivery photo", ok: kinds.includes('delivery') },
    { key: 'reported', label: 'Date the customer reported it', ok: !!input.reportedAt },
    { key: 'tracking', label: 'Tracking or waybill number', ok: !!String(input.tracking || '').trim() },
    { key: 'fault', label: 'Fault decided', ok: !!input.fault && input.fault !== 'unknown' },
  ];
}
