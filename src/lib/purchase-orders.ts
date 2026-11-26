/** Purchase order rules that need no database: status flow, who may approve, line checks and totals. */

export type PoStatus =
  | 'DRAFT'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'SENT'
  | 'PART_RECEIVED'
  | 'RECEIVED'
  | 'CLOSED'
  | 'CANCELLED';

export const PO_STATUSES: PoStatus[] = [
  'DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SENT', 'PART_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED',
];

const FLOW: Record<PoStatus, PoStatus[]> = {
  DRAFT: ['AWAITING_APPROVAL', 'CANCELLED'],
  AWAITING_APPROVAL: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['SENT', 'AWAITING_APPROVAL', 'CANCELLED'],
  SENT: ['PART_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'],
  PART_RECEIVED: ['RECEIVED', 'CLOSED'],
  RECEIVED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
};

export function canMove(from: PoStatus, to: PoStatus): boolean {
  return FLOW[from]?.includes(to) ?? false;
}

/** Lines may change until the PO has gone to the supplier. A change after approval needs approving again. */
export function linesEditable(status: PoStatus): boolean {
  return status === 'DRAFT' || status === 'AWAITING_APPROVAL' || status === 'APPROVED';
}

/**
 * Who may approve. The caller must hold the approve permission, and by default may not approve a PO they created
 * themselves (set PO_ALLOW_SELF_APPROVAL=1 to allow it).
 */
export function approvalDecision(input: {
  hasPermission: boolean;
  approverId: string | undefined;
  creatorId: string | null | undefined;
  allowSelf?: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.hasPermission) return { ok: false, reason: 'Only a PO approver can approve a purchase order' };
  if (!input.allowSelf && input.creatorId && input.approverId && String(input.creatorId) === String(input.approverId)) {
    return { ok: false, reason: 'You created this purchase order, so another approver has to approve it' };
  }
  return { ok: true };
}

export function allowSelfApproval(): boolean {
  return /^(1|true|yes)$/i.test(String(process.env.PO_ALLOW_SELF_APPROVAL || ''));
}

export interface PoLineInput {
  sku: string;
  quantity: number;
  unit_price: number;
  description?: string;
  /** Needed only when the SKU is not in the catalogue yet: the name to give the new hidden item. */
  new_item_title?: string;
}

export interface CleanLine {
  sku: string;
  quantity: number;
  unit_price: number;
  description: string | null;
  new_item_title: string | null;
}

/** Normalise and check lines. Returns every problem found so the person can fix them in one go. */
export function cleanLines(raw: unknown): { lines: CleanLine[]; errors: string[] } {
  const errors: string[] = [];
  const lines: CleanLine[] = [];
  if (!Array.isArray(raw) || raw.length === 0) return { lines, errors: ['Add at least one line'] };
  const seen = new Set<string>();
  raw.forEach((row: any, i: number) => {
    const n = i + 1;
    const sku = String(row?.sku ?? '').trim();
    const quantity = Number(row?.quantity);
    const price = Number(row?.unit_price);
    if (!sku) { errors.push(`Line ${n}: SKU is required`); return; }
    if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(sku)) { errors.push(`Line ${n}: "${sku}" is not a valid SKU`); return; }
    if (!Number.isInteger(quantity) || quantity <= 0) { errors.push(`Line ${n} (${sku}): quantity must be a whole number above 0`); return; }
    if (!Number.isFinite(price) || price < 0 || row?.unit_price === '' || row?.unit_price == null) {
      errors.push(`Line ${n} (${sku}): price is required`); return;
    }
    const key = sku.toLowerCase();
    if (seen.has(key)) { errors.push(`Line ${n}: ${sku} is on this order twice, combine the quantities`); return; }
    seen.add(key);
    lines.push({
      sku,
      quantity,
      unit_price: Math.round(price * 10000) / 10000,
      description: row?.description ? String(row.description).trim() || null : null,
      new_item_title: row?.new_item_title ? String(row.new_item_title).trim() || null : null,
    });
  });
  return { lines, errors };
}

export function poTotal(lines: { quantity_ordered?: number; quantity?: number; unit_price: number | string }[]): number {
  const sum = lines.reduce((acc, l) => acc + Number(l.quantity_ordered ?? l.quantity ?? 0) * Number(l.unit_price), 0);
  return Math.round(sum * 100) / 100;
}

/** The PO status a stock-in should leave it in, from the line totals. */
export function receivedStatus(lines: { quantity_ordered: number; quantity_received: number }[]): 'SENT' | 'PART_RECEIVED' | 'RECEIVED' {
  const got = lines.reduce((a, l) => a + Math.max(0, l.quantity_received), 0);
  if (got <= 0) return 'SENT';
  return lines.every((l) => l.quantity_received >= l.quantity_ordered) ? 'RECEIVED' : 'PART_RECEIVED';
}
