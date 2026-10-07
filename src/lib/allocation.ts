/**
 * Stock Sold V2 allocation engine ("pay when sold").
 *
 * A unit becomes payable when a paid order line is covered by stock we hold. Stock for each SKU sits in two pools:
 *   Bisley stock - received (check-ins + opening adjustments) and not yet allocated as payable;
 *   our own stock - resell returns, plus units we already paid for whose order was cancelled after its week was locked.
 * An allocation uses our own stock first (not payable) and Bisley stock for the rest (payable, on the statement).
 *
 * runAllocation() is idempotent: it frees allocations whose demand has gone (cancelled, edited down, refunded, deleted),
 * then tops up unmet demand oldest order first. Nothing here changes pick lists, stock or dispatch - it only writes the
 * V2 tables. Call scheduleAllocationRun() after anything that can change demand or stock; it is debounced and serialised.
 */
import { getPool, query } from '../db/index.js';
import { currentWeekStart } from './weeks.js';
import { setAuditContext } from './audit.js';

interface DemandRow {
  key: string;
  itemId: string;
  pickListId: string;
  pickListNumber: string | null;
  orderId: string | null;
  orderedAt: Date | null;
  sku: string;
  custom: boolean;
  title: string | null;
  required: number;
}

interface ActiveRow {
  id: string;
  pick_list_item_id: string;
  sku: string;
  kind: string;
  qty: number;
  payable_qty: number;
  owned_qty: number;
  week_start: string;
  ordered_at: Date | null;
  allocated_at: Date;
}

export interface Pool {
  received: number;
  payable: number;
  releasedPaid: number;
  ownedActive: number;
  resell: number;
  activeQty: number;
  activeNotShipped: number;
}

export interface AllocationResult { allocated: number; released: number; custom: number }

const DEMAND_SQL = `
  SELECT pli.id AS item_id, pl.id AS pick_list_id, pl.pick_list_number, pl.medusa_order_id, pl.created_at AS ordered_at,
         pli.product_sku, pli.quantity_required AS q, pli.is_custom, pli.item_title,
         wp.is_kit, wp.kit_components
  FROM pick_list_items pli
  JOIN pick_lists pl ON pl.id = pli.pick_list_id
  LEFT JOIN LATERAL (
    SELECT is_kit, kit_components FROM wms_products WHERE variant_sku = pli.product_sku ORDER BY is_archived LIMIT 1
  ) wp ON true
  WHERE NOT pl.is_sandbox AND NOT pli.is_sandbox
    AND (NOT pli.is_archived OR (pl.is_archived AND pl.status = 'DISPATCHED'))
    AND (NOT pl.is_archived OR pl.status = 'DISPATCHED')
    AND pl.status <> 'CANCELLED'
    AND (pl.status = 'DISPATCHED' OR pl.payment_status IN ('captured', 'partially_refunded'))
    AND pli.product_sku NOT LIKE 'FINSAMPLE-%'
    AND pli.quantity_required > 0
  ORDER BY pl.created_at, pl.pick_list_number, pli.line_number`;

type Db = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

/** Everything we have ever received for each SKU, and how much of it has been paid for, owned, or allocated. */
export async function loadPools(db: Db): Promise<Map<string, Pool>> {
  const pools = new Map<string, Pool>();
  const get = (sku: string): Pool => {
    let p = pools.get(sku);
    if (!p) pools.set(sku, p = { received: 0, payable: 0, releasedPaid: 0, ownedActive: 0, resell: 0, activeQty: 0, activeNotShipped: 0 });
    return p;
  };

  const received = await db.query(`
    SELECT sku, SUM(q)::int AS q FROM (
      SELECT COALESCE(ci.medusa_sku, ci.nw_code) AS sku, ci.quantity_scanned AS q
      FROM checkin_items ci JOIN checkin_sessions s ON s.id = ci.session_id
      WHERE s.status = 'COMPLETE' AND NOT COALESCE(s.is_sandbox, false) AND ci.removed_at IS NULL
      UNION ALL
      SELECT sku, qty AS q FROM stock_adjustments
    ) r WHERE sku IS NOT NULL GROUP BY sku`);
  for (const r of received.rows) get(r.sku).received = Number(r.q);

  const alloc = await db.query(`
    SELECT a.sku,
      COALESCE(SUM(a.payable_qty) FILTER (WHERE a.status IN ('ACTIVE', 'RELEASED_PAID')), 0)::int AS payable,
      COALESCE(SUM(a.payable_qty) FILTER (WHERE a.status = 'RELEASED_PAID'), 0)::int AS released_paid,
      COALESCE(SUM(a.owned_qty) FILTER (WHERE a.status = 'ACTIVE'), 0)::int AS owned_active,
      COALESCE(SUM(a.qty) FILTER (WHERE a.status = 'ACTIVE'), 0)::int AS active_qty,
      COALESCE(SUM(a.qty) FILTER (WHERE a.status = 'ACTIVE' AND COALESCE(pl.status, '') <> 'DISPATCHED'), 0)::int AS not_shipped
    FROM sale_allocations a LEFT JOIN pick_lists pl ON pl.id = a.pick_list_id
    WHERE a.kind = 'STOCK' GROUP BY a.sku`);
  for (const r of alloc.rows) {
    const p = get(r.sku);
    p.payable = r.payable; p.releasedPaid = r.released_paid; p.ownedActive = r.owned_active;
    p.activeQty = r.active_qty; p.activeNotShipped = r.not_shipped;
  }

  const resell = await db.query(`SELECT sku, SUM(quantity)::int AS q FROM stock_returns WHERE status = 'RESELL' GROUP BY sku`);
  for (const r of resell.rows) get(r.sku).resell = Number(r.q);
  return pools;
}

export const bisleyFree = (p: Pool) => p.received - p.payable;
export const ownedFree = (p: Pool) => p.resell + p.releasedPaid - p.ownedActive;

export async function runAllocation(reason = 'manual run'): Promise<AllocationResult> {
  const client = await getPool().connect();
  const result: AllocationResult = { allocated: 0, released: 0, custom: 0 };
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(727001)');
    await setAuditContext(client, { actor: 'system', source: 'allocation', reason });

    // 1. Current demand, with each line's component breakdown frozen the first time it is seen
    const items = (await client.query(DEMAND_SQL)).rows;
    const ids = items.map((i: any) => i.item_id);
    const frozen = new Set<string>((await client.query(`SELECT DISTINCT pick_list_item_id FROM sale_demand WHERE pick_list_item_id = ANY($1::uuid[])`, [ids])).rows.map((r: any) => r.pick_list_item_id));
    for (const it of items) {
      if (frozen.has(it.item_id)) continue;
      const comps = it.is_kit && Array.isArray(it.kit_components) && it.kit_components.length ? it.kit_components : null;
      if (it.is_custom) {
        await client.query(`INSERT INTO sale_demand (pick_list_item_id, component_sku, per_unit_qty, is_custom, title) VALUES ($1, 'CUSTOM', 1, true, $2) ON CONFLICT DO NOTHING`, [it.item_id, it.item_title]);
      } else if (comps) {
        for (const c of comps) {
          await client.query(`INSERT INTO sale_demand (pick_list_item_id, component_sku, per_unit_qty) VALUES ($1, $2, $3) ON CONFLICT (pick_list_item_id, component_sku) DO UPDATE SET per_unit_qty = sale_demand.per_unit_qty + EXCLUDED.per_unit_qty`, [it.item_id, c.sku, Number(c.required_quantity) || 1]);
        }
      } else {
        await client.query(`INSERT INTO sale_demand (pick_list_item_id, component_sku, per_unit_qty) VALUES ($1, $2, 1) ON CONFLICT DO NOTHING`, [it.item_id, it.product_sku]);
      }
    }
    const perUnit = new Map<string, { sku: string; per: number; custom: boolean; title: string | null }[]>();
    for (const r of (await client.query(`SELECT pick_list_item_id, component_sku, per_unit_qty, is_custom, title FROM sale_demand WHERE pick_list_item_id = ANY($1::uuid[])`, [ids])).rows) {
      const list = perUnit.get(r.pick_list_item_id) ?? perUnit.set(r.pick_list_item_id, []).get(r.pick_list_item_id)!;
      list.push({ sku: r.component_sku, per: r.per_unit_qty, custom: r.is_custom, title: r.title });
    }
    const demand: DemandRow[] = [];
    for (const it of items) {
      for (const p of perUnit.get(it.item_id) ?? []) {
        demand.push({
          key: `${it.item_id}|${p.sku}`, itemId: it.item_id, pickListId: it.pick_list_id, pickListNumber: it.pick_list_number, orderId: it.medusa_order_id, orderedAt: it.ordered_at,
          sku: p.sku, custom: p.custom, title: p.title, required: Number(it.q) * p.per,
        });
      }
    }
    const demandByKey = new Map(demand.map((d) => [d.key, d]));

    // 2. Pools and existing active allocations
    const pools = await loadPools(client);
    const mem = new Map<string, { bisley: number; owned: number }>();
    const poolOf = (sku: string) => {
      let m = mem.get(sku);
      if (!m) {
        const p = pools.get(sku);
        mem.set(sku, m = { bisley: p ? bisleyFree(p) : 0, owned: p ? ownedFree(p) : 0 });
      }
      return m;
    };
    const locked = new Set<string>((await client.query(`SELECT week_start::text AS w FROM settlement_weeks WHERE locked_at IS NOT NULL`)).rows.map((r: any) => r.w));
    const active: ActiveRow[] = (await client.query(`SELECT id, pick_list_item_id, sku, kind, qty, payable_qty, owned_qty, week_start::text AS week_start, ordered_at, allocated_at FROM sale_allocations WHERE status = 'ACTIVE' ORDER BY allocated_at DESC, id`)).rows;
    const byKey = new Map<string, ActiveRow[]>();
    for (const r of active) {
      const k = `${r.pick_list_item_id}|${r.sku}`;
      (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r);
    }
    const allocated = new Map<string, number>();

    // 3. Release what is no longer demanded, newest allocation first
    for (const [key, rows] of byKey) {
      const need = demandByKey.get(key)?.required ?? 0;
      let have = rows.reduce((s, r) => s + r.qty, 0);
      let excess = have - need;
      for (const row of rows) {
        if (excess <= 0) break;
        const amt = Math.min(row.qty, excess);
        const isLocked = locked.has(row.week_start);
        const rp = Math.min(amt, row.payable_qty);
        const ro = amt - rp;
        const status = isLocked ? 'RELEASED_PAID' : 'RELEASED';
        if (amt === row.qty) {
          await client.query(`UPDATE sale_allocations SET status = $2, released_at = NOW() WHERE id = $1`, [row.id, status]);
        } else {
          await client.query(`UPDATE sale_allocations SET qty = qty - $2, payable_qty = payable_qty - $3, owned_qty = owned_qty - $4 WHERE id = $1`, [row.id, amt, rp, ro]);
          await client.query(
            `INSERT INTO sale_allocations (pick_list_item_id, pick_list_id, pick_list_number, medusa_order_id, sku, kind, title, qty, payable_qty, owned_qty, status, ordered_at, allocated_at, week_start, released_at)
             SELECT pick_list_item_id, pick_list_id, pick_list_number, medusa_order_id, sku, kind, title, $2, $3, $4, $5, ordered_at, allocated_at, week_start, NOW() FROM sale_allocations WHERE id = $1`,
            [row.id, amt, rp, ro, status]
          );
        }
        if (row.kind === 'STOCK') {
          const m = poolOf(row.sku);
          m.owned += ro + (isLocked ? rp : 0);
          m.bisley += isLocked ? 0 : rp;
        }
        row.qty -= amt;
        excess -= amt;
        result.released += amt;
      }
      have = rows.reduce((s, r) => s + r.qty, 0);
      allocated.set(key, have);
    }

    // 4. Top up unmet demand, oldest order first
    const week = currentWeekStart();
    for (const d of demand) {
      const have = allocated.get(d.key) ?? (byKey.get(d.key) ?? []).reduce((s, r) => s + r.qty, 0);
      let need = d.required - have;
      if (need <= 0) continue;
      if (d.custom) {
        await client.query(
          `INSERT INTO sale_allocations (pick_list_item_id, pick_list_id, pick_list_number, medusa_order_id, sku, kind, title, qty, payable_qty, owned_qty, ordered_at, week_start)
           VALUES ($1, $2, $6, $7, 'CUSTOM', 'CUSTOM', $3, $4, $4, 0, $5, $8)`,
          [d.itemId, d.pickListId, d.title, need, d.orderedAt, d.pickListNumber, d.orderId, week]
        );
        result.custom += need;
        continue;
      }
      const m = poolOf(d.sku);
      const takeOwned = Math.min(need, Math.max(0, m.owned));
      need -= takeOwned;
      const takeBisley = Math.min(need, Math.max(0, m.bisley));
      if (takeOwned + takeBisley <= 0) continue;
      m.owned -= takeOwned;
      m.bisley -= takeBisley;
      await client.query(
        `INSERT INTO sale_allocations (pick_list_item_id, pick_list_id, pick_list_number, medusa_order_id, sku, kind, qty, payable_qty, owned_qty, ordered_at, week_start)
         VALUES ($1, $2, $9, $10, $3, 'STOCK', $4, $5, $6, $7, $8)`,
        [d.itemId, d.pickListId, d.sku, takeOwned + takeBisley, takeBisley, takeOwned, d.orderedAt, week, d.pickListNumber, d.orderId]
      );
      result.allocated += takeOwned + takeBisley;
    }

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let again = false;
const pendingReasons = new Set<string>();

/** Debounced, serialised, never throws: safe to call after any change that could affect demand or stock. The reasons are written to the audit trail. */
export function scheduleAllocationRun(reason = 'scheduled check', delayMs = 3000): void {
  if (pendingReasons.size < 25) pendingReasons.add(reason);
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        const why = [...pendingReasons].join('; ').slice(0, 1000);
        pendingReasons.clear();
        const r = await runAllocation(why || 'scheduled check');
        if (r.allocated || r.released || r.custom) console.log(`[allocation] allocated ${r.allocated}, released ${r.released}, custom ${r.custom} (${why})`);
      } while (again);
    } catch (err) {
      console.warn('[allocation] run failed:', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  }, delayMs);
}

export { query };
