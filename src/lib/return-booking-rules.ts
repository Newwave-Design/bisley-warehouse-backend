/**
 * A replacement is a Plan picks order. It is not placed on a pick list.
 * A refund does not create an order. Collect only does not create one and does not refund either: the goods just come back. A booked collection has to be cancelled before the choice changes.
 */

export function outcomeChange(
  existing: { status?: string; outcome?: string } | null,
  next: 'refund' | 'replace' | 'collect',
) {
  if (existing?.status === 'booked') {
    if (existing.outcome === next) return { ok: true as const, createOrder: false, releaseOrder: false }
    return {
      ok: false as const,
      error: 'Cancel the collection before changing what this booked return is for.',
    }
  }
  return {
    ok: true as const,
    createOrder: next === 'replace',
    releaseOrder: next !== 'replace',
  }
}
