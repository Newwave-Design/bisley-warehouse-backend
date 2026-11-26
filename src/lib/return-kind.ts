/**
 * Which view a return belongs in. Damage is anything where the goods were not as they should be on arrival
 * (damaged, faulty, wrong item, missing part, a courier problem), a part refund where the customer keeps the goods,
 * or an item that was found damaged or faulty on inspection. Everything else is an ordinary return.
 */
export type ReturnKind = 'return' | 'damage';

const DAMAGE_WORDS = /damag|fault|wrong item|missing part|courier problem|broken|crush|scratch/i;

export interface KindInput {
  return_reason?: string | null;
  how_back?: string | null;
  courier_problem?: string | null;
  items?: { item_condition?: string | null }[] | null;
}

export function returnKind(row: KindInput): ReturnKind {
  if (row.how_back === 'kept') return 'damage';
  if (row.courier_problem && row.courier_problem !== 'lost') return 'damage';
  if (DAMAGE_WORDS.test(String(row.return_reason || ''))) return 'damage';
  if ((row.items || []).some((item) => /damag|fault|wrong item/i.test(String(item.item_condition || '')))) return 'damage';
  return 'return';
}
