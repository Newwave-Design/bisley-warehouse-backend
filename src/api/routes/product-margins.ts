/**
 * One row per listed product (not per colour).
 * Prices, packaging, courier cost and the customer shipping charge come from SmartSuite.
 * Cost comes from Chris Miller's order spreadsheet where that product has a buy price.
 * Run rate is paid shop sales since the first paid order, scaled to 30 days.
 */
import express from 'express';
import { readFileSync } from 'fs';
import { authMiddleware } from '../../middleware/auth.js';
import { query } from '../../db/index.js';

const router = express.Router();
router.use(authMiddleware);

type MarginRow = {
  code: string
  unitsPerMonth: number
  marginGbp: number | null
  marginPerMonth: number | null
}

const rows = JSON.parse(
  readFileSync(new URL('../../data/product-margins.json', import.meta.url), 'utf8')
) as MarginRow[];

/** Longest listed product code that the sold SKU is, or that it starts with before a colour suffix. */
function matchCode(sku: string, codes: string[]): string | null {
  const sold = sku.trim().toUpperCase()
  let best: string | null = null
  for (const code of codes) {
    const listed = code.toUpperCase()
    if (sold === listed || sold.startsWith(listed + '-')) {
      if (!best || listed.length > best.length) best = code
    }
  }
  return best
}

router.get('/', async (_req, res) => {
  try {
    const span = await query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) / 86400.0 AS days
       FROM pick_lists
       WHERE NOT is_sandbox
         AND status <> 'CANCELLED'
         AND payment_status IN ('captured', 'partially_refunded')`
    )
    const days = Math.max(1, Number(span.rows[0]?.days) || 1)
    const sold = await query(
      `SELECT pli.product_sku AS sku, SUM(pli.quantity_required)::float AS units
       FROM pick_list_items pli
       JOIN pick_lists pl ON pl.id = pli.pick_list_id
       WHERE NOT pl.is_sandbox
         AND pl.status <> 'CANCELLED'
         AND pl.payment_status IN ('captured', 'partially_refunded')
         AND COALESCE(pli.is_custom, false) = false
         AND pli.product_sku IS NOT NULL
         AND pli.product_sku NOT ILIKE '%SAMPLE%'
       GROUP BY pli.product_sku`
    )
    const codes = rows.map((row) => row.code)
    const units = new Map<string, number>()
    for (const line of sold.rows as { sku: string; units: number }[]) {
      const code = matchCode(line.sku, codes)
      if (!code) continue
      units.set(code, (units.get(code) || 0) + Number(line.units))
    }
    const products = rows.map((row) => {
      const unitsPerMonth = Math.round(((units.get(row.code) || 0) * 30 / days) * 10) / 10
      const marginPerMonth = row.marginGbp == null ? null : Math.round(row.marginGbp * unitsPerMonth * 100) / 100
      return { ...row, unitsPerMonth, marginPerMonth }
    })
    res.json({ products, runRateDays: Math.round(days) })
  } catch (err: any) {
    res.status(500).json({ error: 'Could not load product margins.' })
  }
});

export default router;
