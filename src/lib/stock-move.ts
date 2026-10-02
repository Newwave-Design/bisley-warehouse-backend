/**
 * Transactional bay-to-bay stock move (used by /api/mobile/move and /api/move-sessions).
 * Deducts from the source bay, adds to the destination and writes both movement records,
 * all in one transaction so a failure can't leave stock half-moved.
 */
import { getPool } from '../db/index.js';

export class MoveError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface MoveParams {
  fromCode: string;
  toCode: string;
  sku: string;
  colourCode: string | null;
  quantity: number;
  userId: string | null;
}

export async function moveStockBetweenBays(p: MoveParams): Promise<{ movement_out: string; movement_in: string }> {
  const fromCode = p.fromCode.toUpperCase();
  const toCode = p.toCode.toUpperCase();
  const colour = p.colourCode ?? null;

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const [fromLoc, toLoc] = await Promise.all([
      client.query(`SELECT id FROM warehouse_locations WHERE location_code = $1`, [fromCode]),
      client.query(`SELECT id FROM warehouse_locations WHERE location_code = $1`, [toCode]),
    ]);
    if (!fromLoc.rows[0]) throw new MoveError(`Bay ${p.fromCode} not found`, 404);
    if (!toLoc.rows[0]) throw new MoveError(`Bay ${p.toCode} not found`, 404);
    const fromId = fromLoc.rows[0].id;
    const toId = toLoc.rows[0].id;

    const src = await client.query(
      `SELECT quantity FROM warehouse_inventory
       WHERE location_id=$1 AND product_sku=$2 AND (colour_code=$3 OR $3 IS NULL) FOR UPDATE`,
      [fromId, p.sku, colour]
    );
    if (!src.rows[0] || src.rows[0].quantity < p.quantity) {
      throw new MoveError(`Insufficient stock at ${p.fromCode}`);
    }

    await client.query(
      `UPDATE warehouse_inventory SET quantity = quantity - $1, updated_at = NOW()
       WHERE location_id=$2 AND product_sku=$3 AND (colour_code=$4 OR $4 IS NULL)`,
      [p.quantity, fromId, p.sku, colour]
    );

    await client.query(
      `INSERT INTO warehouse_inventory (location_id, product_sku, colour_code, quantity)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (location_id, product_sku, COALESCE(colour_code, ''))
       DO UPDATE SET quantity = warehouse_inventory.quantity + $4, updated_at = NOW()`,
      [toId, p.sku, colour, p.quantity]
    );

    const mvtOut = await client.query(
      `INSERT INTO warehouse_movements (movement_type,location_id,product_sku,colour_code,quantity,notes,performed_by,movement_date)
       VALUES ('ADJUST',$1,$2,$3,$4,$5,$6,NOW()) RETURNING id`,
      [fromId, p.sku, colour, -p.quantity, `Moved to ${p.toCode}`, p.userId]
    );
    const mvtIn = await client.query(
      `INSERT INTO warehouse_movements (movement_type,location_id,product_sku,colour_code,quantity,notes,performed_by,movement_date)
       VALUES ('RECEIVE',$1,$2,$3,$4,$5,$6,NOW()) RETURNING id`,
      [toId, p.sku, colour, p.quantity, `Moved from ${p.fromCode}`, p.userId]
    );

    await client.query('COMMIT');
    return { movement_out: mvtOut.rows[0].id, movement_in: mvtIn.rows[0].id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
