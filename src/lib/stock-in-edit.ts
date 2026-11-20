/** The review total has to land on the scan rows. The latest scan absorbs the edit; if that would go below zero, it keeps the whole total and the earlier scans are cleared. */
export function applyLineEditToScans(scans: { id: string; quantity: number }[], newTotal: number): { id: string; quantity: number }[] {
  if (scans.length === 0) return []
  const earlier = scans.slice(0, -1)
  const earlierSum = earlier.reduce((sum, scan) => sum + scan.quantity, 0)
  const latest = scans[scans.length - 1]
  if (newTotal - earlierSum < 0) {
    return scans.map((scan, index) => ({ id: scan.id, quantity: index === scans.length - 1 ? newTotal : 0 }))
  }
  return [...earlier, { id: latest.id, quantity: newTotal - earlierSum }]
}
