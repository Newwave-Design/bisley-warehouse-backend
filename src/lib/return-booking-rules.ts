/**
 * A replacement is a Plan picks order. It is not placed on a pick list.
 * A refund does not create an order. A booked collection has to be cancelled before the choice changes.
 */

export function outcomeChange(
  existing: { status?: string; outcome?: string } | null,
  next: 'refund' | 'replace',
) {
  if (existing?.status === 'booked') {
    if (existing.outcome === next) return { ok: true as const, createOrder: false, releaseOrder: false }
    return {
      ok: false as const,
      error: 'Cancel the collection before changing this booked return between refund and replacement.',
    }
  }
  return {
    ok: true as const,
    createOrder: next === 'replace',
    releaseOrder: next === 'refund',
  }
}
