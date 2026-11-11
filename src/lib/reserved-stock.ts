/**
 * Move a SKU's reserved count by a delta, on one stock row at a time.
 * Adding hits the bay with the most free stock. Releasing comes off bays that already have a reservation.
 */
type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export async function adjustReserved(db: Queryable, sku: string, delta: number): Promise<void> {
  const change = Math.trunc(delta);
  if (!sku || !change) return;

  if (change > 0) {
    const row = await db.query(
      `SELECT id FROM warehouse_inventory
        WHERE product_sku = $1
        ORDER BY (quantity - quantity_reserved) DESC, quantity DESC
        LIMIT 1`,
      [sku]
    );
    if (!row.rows[0]) return;
    await db.query(
      `UPDATE warehouse_inventory
          SET quantity_reserved = quantity_reserved + $1, updated_at = NOW()
        WHERE id = $2`,
      [change, row.rows[0].id]
    );
    return;
  }

  let left = -change;
  const rows = await db.query(
    `SELECT id, quantity_reserved FROM warehouse_inventory
      WHERE product_sku = $1 AND quantity_reserved > 0
      ORDER BY quantity_reserved DESC`,
    [sku]
  );
  for (const row of rows.rows) {
    if (left <= 0) break;
    const take = Math.min(left, Number(row.quantity_reserved) || 0);
    if (take <= 0) continue;
    await db.query(
      `UPDATE warehouse_inventory
          SET quantity_reserved = quantity_reserved - $1, updated_at = NOW()
        WHERE id = $2`,
      [take, row.id]
    );
    left -= take;
  }
}
