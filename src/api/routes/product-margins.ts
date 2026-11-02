/**
 * One row per listed product (not per colour).
 * Prices, packaging, courier cost and the customer shipping charge come from SmartSuite.
 * Cost comes from Chris Miller's order spreadsheet where that product has a buy price.
 * Run rate is paid shop sales since the first paid order, scaled to 30 days.
 * MultiDesk and Home Filer kits are extra rows. Their cost is the sum of the parts.
 * A part that is also sold on its own keeps its own row.
 */
import express from 'express';
import { readFileSync } from 'fs';
import { authMiddleware } from '../../middleware/auth.js';
import { query } from '../../db/index.js';

const router = express.Router();
router.use(authMiddleware);

type MarginRow = {
  code: string
  title: string
  rrpIncVat: number
  net: number
  cost: number
  costSource: string
  packaging: number
  shipping: number
  shipper: string
  customerCharge: number
  family: string
  marginGbp: number | null
  marginPct: number | null
  unitsPerMonth: number
  marginPerMonth: number | null
}

type KitPart = { sku?: string; required_quantity?: number }

const rows = JSON.parse(
  readFileSync(new URL('../../data/product-margins.json', import.meta.url), 'utf8')
) as MarginRow[];

/** Cabinet codes sold inside a kit use a shorter prefix than the listed product. */
const KIT_PART_ALIAS: Record<string, string> = { PFA2: 'FFPFA2', PFA3: 'FFPFA3' }

function partCode(sku: string, codes: string[]): string | null {
  const direct = matchCode(sku, codes)
  if (direct) return direct
  const base = sku.split('-')[0]?.toUpperCase()
  return (base && KIT_PART_ALIAS[base]) || null
}

function round2(value: number) {
  return Math.round(value * 100) / 100
}

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
    const byCode = new Map(rows.map((row) => [row.code, row]))
    const kits = await query(
      `SELECT product_title, variant_sku, price_gbp, kit_components
       FROM wms_products
       WHERE kit_components IS NOT NULL
         AND jsonb_array_length(kit_components) > 0
         AND variant_sku ~ '^(MD|PFA2|PFA3|FFPFA)'`
    )
    type KitGroup = { title: string; family: string; recipe: string; price: number; parts: { code: string; qty: number }[]; skus: string[]; missing: string[] }
    const groups = new Map<string, KitGroup>()
    const skuToKit = new Map<string, string>()
    for (const kit of kits.rows as { product_title: string; variant_sku: string; price_gbp: string; kit_components: KitPart[] }[]) {
      const parts = Array.isArray(kit.kit_components) ? kit.kit_components : []
      if (!parts.some((part) => part.sku && part.sku !== kit.variant_sku)) continue
      const counted = new Map<string, number>()
      const missing: string[] = []
      for (const part of parts) {
        if (!part.sku || part.sku === kit.variant_sku) continue
        const code = partCode(part.sku, codes)
        const qty = Number(part.required_quantity) || 1
        if (!code) missing.push(part.sku.split('-')[0])
        else counted.set(code, (counted.get(code) || 0) + qty)
      }
      const recipe = [...counted.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([code, qty]) => qty > 1 ? code + ' x' + qty : code).join(' + ')
      const key = kit.product_title + '|' + recipe
      let group = groups.get(key)
      if (!group) {
        const family = /multidesk/i.test(kit.product_title) ? 'MultiDesk' : /filer/i.test(kit.product_title) ? 'Home Filers' : 'Kits'
        group = { title: kit.product_title, family, recipe, price: Number(kit.price_gbp) || 0, parts: [...counted.entries()].map(([code, qty]) => ({ code, qty })), skus: [], missing }
        groups.set(key, group)
      }
      group.skus.push(kit.variant_sku)
      skuToKit.set(kit.variant_sku.toUpperCase(), key)
    }
    const kitUnits = new Map<string, number>()
    const units = new Map<string, number>()
    for (const line of sold.rows as { sku: string; units: number }[]) {
      const kitKey = skuToKit.get(String(line.sku).toUpperCase())
      if (kitKey) {
        kitUnits.set(kitKey, (kitUnits.get(kitKey) || 0) + Number(line.units))
        continue
      }
      const code = matchCode(line.sku, codes)
      if (!code) continue
      units.set(code, (units.get(code) || 0) + Number(line.units))
    }
    const kitRows: MarginRow[] = [...groups.entries()].map(([key, group]) => {
      let cost = 0
      let packaging = 0
      let shipping = 0
      let customerCharge = 0
      let pricedParts = 0
      for (const part of group.parts) {
        const source = byCode.get(part.code)
        if (!source) continue
        pricedParts += 1
        cost += source.cost * part.qty
        packaging += (source.packaging || 0) * part.qty
        shipping = Math.max(shipping, source.shipping || 0)
        customerCharge = Math.max(customerCharge, source.customerCharge || 0)
      }
      const rrpIncVat = round2(group.price)
      const net = round2(rrpIncVat / 1.2)
      const missing = pricedParts < group.parts.length || group.missing.length > 0
      const marginGbp = round2(net - cost - packaging - shipping + customerCharge)
      const marginPct = net > 0 ? Math.round((marginGbp / net) * 1000) / 10 : null
      const unitsPerMonth = Math.round(((kitUnits.get(key) || 0) * 30 / days) * 10) / 10
      return {
        code: group.recipe || group.title,
        title: group.title,
        rrpIncVat,
        net,
        cost: round2(cost),
        costSource: missing ? 'kit parts, some part costs missing' : 'kit parts',
        packaging: round2(packaging),
        shipping: round2(shipping),
        shipper: '',
        customerCharge: round2(customerCharge),
        family: group.family,
        marginGbp,
        marginPct,
        unitsPerMonth,
        marginPerMonth: Math.round(marginGbp * unitsPerMonth * 100) / 100,
      }
    })
    const products = rows.map((row) => {
      const unitsPerMonth = Math.round(((units.get(row.code) || 0) * 30 / days) * 10) / 10
      const marginPerMonth = row.marginGbp == null ? null : Math.round(row.marginGbp * unitsPerMonth * 100) / 100
      return { ...row, unitsPerMonth, marginPerMonth }
    })
    res.json({ products: [...products, ...kitRows], runRateDays: Math.round(days) })
  } catch (err: any) {
    res.status(500).json({ error: 'Could not load product margins.' })
  }
});

export default router;
