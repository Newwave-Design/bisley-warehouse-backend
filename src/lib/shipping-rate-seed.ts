import { v4 as uuid } from 'uuid';
import { query } from '../db/index.js';

/** Load the current DPD card from code into editable rate tables. Safe to re-run. */
export async function seedDpdRateCards() {
  const existing = await query(`SELECT id FROM shipping_rate_cards WHERE courier_code = 'DPD' AND service_code = 'DPD-NWD'`);
  const cardExists = Boolean(existing.rows[0]);
  const cardId = existing.rows[0]?.id || uuid();

  if (!cardExists) {
    await query(
      `INSERT INTO shipping_rate_cards (id, courier_code, service_code, name, currency, effective_from, notes, extra)
       VALUES ($1,'DPD','DPD-NWD','DPD Next Working Day','GBP','2026-09-16',
               'Seeded from the WMS DPD rate card. Edit rows here instead of changing code.',
               $2)`,
      [cardId, JSON.stringify({ volumetric_divisor: 4000, source: 'lib/dpd-rates.ts' })]
    );
  }

  const first: Record<string, { upTo25kg: number; over25kg: number }> = {
    A: { upTo25kg: 5.75, over25kg: 0.29 },
    B: { upTo25kg: 5.75, over25kg: 0.29 },
    C: { upTo25kg: 9.0, over25kg: 0.55 },
    D: { upTo25kg: 12.75, over25kg: 0.75 },
  };
  const next: Record<string, { upTo25kg: number; over25kg: number }> = {
    A: { upTo25kg: 4.5, over25kg: 0.29 },
    B: { upTo25kg: 4.5, over25kg: 0.29 },
    C: { upTo25kg: 7.0, over25kg: 0.55 },
    D: { upTo25kg: 10.75, over25kg: 0.75 },
  };

  if (!cardExists) {
    for (const zone of ['A', 'B', 'C', 'D']) {
      await query(
        `INSERT INTO shipping_rate_rows (id, card_id, zone, min_kg, max_kg, amount_gbp, per_kg_gbp, parcel_index)
         VALUES ($1,$2,$3,0,25,$4,0,1), ($5,$2,$3,25,NULL,$4,$6,1),
                ($7,$2,$3,0,25,$8,0,2), ($9,$2,$3,25,NULL,$8,$10,2)`,
        [
          uuid(), cardId, zone, first[zone].upTo25kg, uuid(), first[zone].over25kg,
          uuid(), next[zone].upTo25kg, uuid(), next[zone].over25kg,
        ]
      );
    }
  }

  const existingSurcharges = await query(
    `SELECT COUNT(*)::int AS n FROM shipping_rate_surcharges WHERE card_id = $1`,
    [cardId]
  );
  if (existingSurcharges.rows[0]?.n > 0) {
    return { seeded: !cardExists, filled_surcharges: false, card_id: cardId };
  }

  const heavy = [
    [30.01, 34, 15.5],
    [34.01, 36, 35],
    [36.01, null, 50],
  ];
  for (const [min, max, amount] of heavy) {
    await query(
      `INSERT INTO shipping_rate_surcharges (id, card_id, surcharge_type, min_value, max_value, amount_gbp)
       VALUES ($1,$2,'heavy_weight',$3,$4,$5)`,
      [uuid(), cardId, min, max, amount]
    );
  }
  const lengths = [
    [100, 119.99, 1], [120, 139.99, 5], [140, 159.99, 6], [160, 179.99, 9],
    [180, 199.99, 14], [200, 219.99, 21], [220, 239.99, 26], [240, 259.99, 31],
    [260, 279.99, 36], [280, 299.99, 51], [300, 319.99, 56], [320, 339.99, 66],
    [340, null, 76],
  ];
  for (const [min, max, amount] of lengths) {
    await query(
      `INSERT INTO shipping_rate_surcharges (id, card_id, surcharge_type, min_value, max_value, amount_gbp)
       VALUES ($1,$2,'long_length_cm',$3,$4,$5)`,
      [uuid(), cardId, min, max, amount]
    );
  }

  return { seeded: !cardExists, filled_surcharges: true, card_id: cardId };
}

type RateRow = { zone: string; min_kg: number; max_kg: number | null; amount: number; per_kg: number };
type RateCardSeed = {
  courier_code: string;
  service_code: string;
  name: string;
  notes: string;
  extra: Record<string, unknown>;
  rows: RateRow[];
  surcharges?: { type: string; amount: number }[];
};

/** Monex APC and Palletways cards from the 30 Oct 2026 estimate. Ex VAT, ex fuel. Safe to re-run. */
const MONEX_CARDS: RateCardSeed[] = [
  {
    courier_code: 'APC',
    service_code: 'APC-ND-1600',
    name: 'APC Next Day 16:00',
    notes: 'Monex APC card, 30 Oct 2026. England & Wales £6.90 up to 20kg then £0.25/kg. Northern Ireland ROAD £18.96 then £0.48/kg. Ex VAT, ex fuel. Volumetric divisor 6000.',
    extra: { volumetric_divisor: 6000, fuel_excluded: true, source: 'monex-shipping-costs-2026-10-30' },
    rows: [
      { zone: 'EW', min_kg: 0, max_kg: 20, amount: 6.9, per_kg: 0 },
      { zone: 'EW', min_kg: 20, max_kg: null, amount: 6.9, per_kg: 0.25 },
      { zone: 'NI', min_kg: 0, max_kg: 20, amount: 18.96, per_kg: 0 },
      { zone: 'NI', min_kg: 20, max_kg: null, amount: 18.96, per_kg: 0.48 },
    ],
  },
  {
    courier_code: 'APC',
    service_code: 'APC-NC-1600',
    name: 'APC Next Day 16:00 (longer)',
    notes: 'Monex APC card, 30 Oct 2026. England & Wales £8.92 up to 20kg then £0.25/kg. Northern Ireland RDNC £21.88 then £0.48/kg. Ex VAT, ex fuel. Volumetric divisor 6000.',
    extra: { volumetric_divisor: 6000, fuel_excluded: true, source: 'monex-shipping-costs-2026-10-30' },
    rows: [
      { zone: 'EW', min_kg: 0, max_kg: 20, amount: 8.92, per_kg: 0 },
      { zone: 'EW', min_kg: 20, max_kg: null, amount: 8.92, per_kg: 0.25 },
      { zone: 'NI', min_kg: 0, max_kg: 20, amount: 21.88, per_kg: 0 },
      { zone: 'NI', min_kg: 20, max_kg: null, amount: 21.88, per_kg: 0.48 },
    ],
  },
  {
    courier_code: 'APC',
    service_code: 'APC-XS',
    name: 'APC Extra Long',
    notes: 'Monex APC card, 30 Oct 2026. England & Wales £13.41 up to 30kg then £0.45/kg. Northern Ireland XS rate was not on the card. Ex VAT, ex fuel.',
    extra: { volumetric_divisor: 6000, fuel_excluded: true, source: 'monex-shipping-costs-2026-10-30' },
    rows: [
      { zone: 'EW', min_kg: 0, max_kg: 30, amount: 13.41, per_kg: 0 },
      { zone: 'EW', min_kg: 30, max_kg: null, amount: 13.41, per_kg: 0.45 },
    ],
  },
  {
    courier_code: 'Palletways',
    service_code: 'PW-QUARTER',
    name: 'Palletways Economy Quarter',
    notes: 'Monex Palletways proposal, 30 Oct 2026. Economy per pallet, zones 1–6. Quarter ≤250kg, ≤800mm. Northern Ireland is zone 14 plus £18 customs. Republic of Ireland is zone 16 plus £60 customs. Premium would be £44.50–£62.50. Kerbside. Tail-lift £2.50. Ex VAT, ex fuel.',
    extra: { source: 'monex-shipping-costs-2026-10-30', premium_low_gbp: 44.5, premium_high_gbp: 62.5 },
    rows: [
      { zone: 'GB1', min_kg: 0, max_kg: null, amount: 43.5, per_kg: 0 },
      { zone: 'GB6', min_kg: 0, max_kg: null, amount: 59, per_kg: 0 },
      { zone: 'NI', min_kg: 0, max_kg: null, amount: 109, per_kg: 0 },
      { zone: 'ROI', min_kg: 0, max_kg: null, amount: 166, per_kg: 0 },
    ],
    surcharges: [{ type: 'tail_lift', amount: 2.5 }],
  },
  {
    courier_code: 'Palletways',
    service_code: 'PW-HALF',
    name: 'Palletways Economy Half',
    notes: 'Monex Palletways proposal, 30 Oct 2026. Economy per pallet, zones 1–6. Half ≤500kg, ≤1100mm. Northern Ireland is zone 14 plus £18 customs. Republic of Ireland is zone 16 plus £60 customs. Premium would be £46.50–£68.00. Kerbside. Tail-lift £2.50. Ex VAT, ex fuel.',
    extra: { source: 'monex-shipping-costs-2026-10-30', premium_low_gbp: 46.5, premium_high_gbp: 68 },
    rows: [
      { zone: 'GB1', min_kg: 0, max_kg: null, amount: 45, per_kg: 0 },
      { zone: 'GB6', min_kg: 0, max_kg: null, amount: 61, per_kg: 0 },
      { zone: 'NI', min_kg: 0, max_kg: null, amount: 112, per_kg: 0 },
      { zone: 'ROI', min_kg: 0, max_kg: null, amount: 171, per_kg: 0 },
    ],
    surcharges: [{ type: 'tail_lift', amount: 2.5 }],
  },
  {
    courier_code: 'Palletways',
    service_code: 'PW-LIGHT',
    name: 'Palletways Economy Light',
    notes: 'Monex Palletways proposal, 30 Oct 2026. Economy per pallet, zones 1–6. Light ≤750kg, ≤2200mm. Northern Ireland is zone 14 plus £18 customs. Republic of Ireland is zone 16 plus £60 customs. Premium would be £49.50–£72.50. Kerbside. Tail-lift £2.50. Ex VAT, ex fuel.',
    extra: { source: 'monex-shipping-costs-2026-10-30', premium_low_gbp: 49.5, premium_high_gbp: 72.5 },
    rows: [
      { zone: 'GB1', min_kg: 0, max_kg: null, amount: 45, per_kg: 0 },
      { zone: 'GB6', min_kg: 0, max_kg: null, amount: 64, per_kg: 0 },
      { zone: 'NI', min_kg: 0, max_kg: null, amount: 124.5, per_kg: 0 },
      { zone: 'ROI', min_kg: 0, max_kg: null, amount: 186.5, per_kg: 0 },
    ],
    surcharges: [{ type: 'tail_lift', amount: 2.5 }],
  },
];

export async function seedMonexRateCards() {
  const seeded: string[] = [];
  const skipped: string[] = [];
  for (const card of MONEX_CARDS) {
    const existing = await query(
      `SELECT id FROM shipping_rate_cards WHERE courier_code = $1 AND service_code = $2`,
      [card.courier_code, card.service_code]
    );
    if (existing.rows[0]) {
      skipped.push(card.service_code);
      continue;
    }
    const cardId = uuid();
    await query(
      `INSERT INTO shipping_rate_cards (id, courier_code, service_code, name, currency, effective_from, notes, extra)
       VALUES ($1,$2,$3,$4,'GBP','2026-10-30',$5,$6)`,
      [cardId, card.courier_code, card.service_code, card.name, card.notes, JSON.stringify(card.extra)]
    );
    for (const row of card.rows) {
      await query(
        `INSERT INTO shipping_rate_rows (id, card_id, zone, min_kg, max_kg, amount_gbp, per_kg_gbp, parcel_index)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
        [uuid(), cardId, row.zone, row.min_kg, row.max_kg, row.amount, row.per_kg]
      );
    }
    for (const surcharge of card.surcharges || []) {
      await query(
        `INSERT INTO shipping_rate_surcharges (id, card_id, surcharge_type, amount_gbp)
         VALUES ($1,$2,$3,$4)`,
        [uuid(), cardId, surcharge.type, surcharge.amount]
      );
    }
    seeded.push(card.service_code);
  }
  return { seeded, skipped };
}
