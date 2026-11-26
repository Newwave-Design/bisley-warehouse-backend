/**
 * Where a return has got to, for the Returns screen and the dashboard.
 * The stored stage (desk_status) only starts at Due back, so the steps before the goods arrive come from the collection booking.
 */

export const RETURN_STEPS = ['Asked for', 'Collection booked', 'Collected', 'Received', 'Decided', 'Closed'] as const

export interface ReturnCollection {
  courier: string | null
  waybill: string | null
  /** dd/mm/yyyy, as the courier booking stores it. */
  collection_date: string | null
  service_name: string | null
}

export interface ReturnProgress {
  /** Index into RETURN_STEPS of the step the return is on. */
  step: number
  label: string
  detail: string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** dd/mm/yyyy (or yyyy-mm-dd) as a yyyy-mm-dd day, or null. */
export function isoDay(value: string | null | undefined): string | null {
  const text = String(value || '').trim();
  let match = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(text);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function shortDay(iso: string): string {
  const [, month, day] = iso.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1] || month}`;
}

function collectionText(collection: ReturnCollection, iso: string | null): string {
  return [collection.courier, iso ? shortDay(iso) : null, collection.waybill ? `waybill ${collection.waybill}` : null].filter(Boolean).join(' · ');
}

export function returnProgress(input: { desk_status?: string | null; how_back?: string | null; outcome?: string | null }, collection: ReturnCollection | null, today: string): ReturnProgress {
  const status = input.desk_status || 'due_back';
  if (status === 'closed') return { step: 5, label: 'Closed', detail: '' };
  if (status === 'claim') return { step: 4, label: 'Claim with Bisley', detail: '' };
  if (status === 'to_refund') return { step: 4, label: 'Refund to pay', detail: '' };
  if (status === 'to_decide') return { step: 4, label: 'To decide', detail: 'Goods are back. Decide what happens to them.' };
  if (status === 'to_inspect') return { step: 3, label: 'Received, to inspect', detail: 'Goods are at the warehouse.' };
  if (input.how_back === 'kept') return { step: 4, label: 'To decide', detail: 'The customer keeps the goods.' };
  if (!collection) return { step: 0, label: 'Collection to book', detail: 'No courier collection is booked yet.' };
  const iso = isoDay(collection.collection_date);
  const text = collectionText(collection, iso);
  if (iso && iso <= today) return { step: 2, label: 'Collection day passed', detail: `${text}. Receive it when it arrives.` };
  return { step: 1, label: 'Collection booked', detail: text };
}
