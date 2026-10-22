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
