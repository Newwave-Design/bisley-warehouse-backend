/**
 * Creates the Stock Sold V2 audit table, its trigger functions and the triggers on every V2 table.
 * Safe to run on every boot: everything is CREATE ... IF NOT EXISTS / OR REPLACE, and triggers are recreated.
 * The audit table is append-only: updates, deletes and truncates are rejected by trigger.
 */
import { query } from './index.js';

export const AUDITED_TABLES = ['sale_allocations', 'sale_demand', 'settlement_weeks', 'settlement_week_lines', 'stock_adjustments', 'stock_returns'];

export const AUDIT_TABLE_SQL = `CREATE TABLE IF NOT EXISTS stock_sold_audit (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  table_name TEXT NOT NULL,
  action TEXT NOT NULL,
  row_id TEXT,
  sku TEXT,
  pick_list_number TEXT,
  medusa_order_id TEXT,
  pick_list_item_id UUID,
  week_start DATE,
  qty_delta INT,
  payable_delta INT,
  owned_delta INT,
  old_row JSONB,
  new_row JSONB,
  actor TEXT,
  source TEXT,
  reason TEXT
)`;

export const AUDIT_INDEX_SQL = [
  `CREATE INDEX IF NOT EXISTS idx_ssa_at ON stock_sold_audit (at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ssa_sku ON stock_sold_audit (sku, at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ssa_order ON stock_sold_audit (medusa_order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ssa_week ON stock_sold_audit (week_start)`,
];

// Deltas describe the effect on units counted as sold (ACTIVE rows only), so summing them over time gives the live total.
export const AUDIT_FN_SQL = `CREATE OR REPLACE FUNCTION stock_sold_audit_fn() RETURNS trigger AS $fn$
DECLARE
  o jsonb;
  n jsonb;
  r jsonb;
  oq int := 0; nq int := 0; op int := 0; np int := 0; oo int := 0; no int := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN o := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN n := to_jsonb(NEW); END IF;
  r := COALESCE(n, o);
  IF TG_TABLE_NAME = 'sale_allocations' THEN
    IF o IS NOT NULL AND o->>'status' = 'ACTIVE' THEN oq := (o->>'qty')::int; op := (o->>'payable_qty')::int; oo := (o->>'owned_qty')::int; END IF;
    IF n IS NOT NULL AND n->>'status' = 'ACTIVE' THEN nq := (n->>'qty')::int; np := (n->>'payable_qty')::int; no := (n->>'owned_qty')::int; END IF;
  END IF;
  INSERT INTO stock_sold_audit (table_name, action, row_id, sku, pick_list_number, medusa_order_id, pick_list_item_id, week_start,
                                qty_delta, payable_delta, owned_delta, old_row, new_row, actor, source, reason)
  VALUES (TG_TABLE_NAME, TG_OP,
          COALESCE(r->>'id', r->>'week_start', (r->>'pick_list_item_id') || '|' || (r->>'component_sku')),
          COALESCE(r->>'sku', r->>'component_sku'), r->>'pick_list_number', r->>'medusa_order_id',
          NULLIF(r->>'pick_list_item_id', '')::uuid, NULLIF(r->>'week_start', '')::date,
          CASE WHEN TG_TABLE_NAME = 'sale_allocations' THEN nq - oq END,
          CASE WHEN TG_TABLE_NAME = 'sale_allocations' THEN np - op END,
          CASE WHEN TG_TABLE_NAME = 'sale_allocations' THEN no - oo END,
          o, n,
          COALESCE(NULLIF(current_setting('app.audit_actor', true), ''), 'db:' || session_user),
          COALESCE(NULLIF(current_setting('app.audit_source', true), ''), 'direct'),
          NULLIF(current_setting('app.audit_reason', true), ''));
  RETURN NULL;
END;
$fn$ LANGUAGE plpgsql`;

export const AUDIT_GUARD_FN_SQL = `CREATE OR REPLACE FUNCTION stock_sold_audit_guard() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'stock_sold_audit is append-only';
END;
$fn$ LANGUAGE plpgsql`;

export function triggerStatements(table: string): string[] {
  return [
    `DROP TRIGGER IF EXISTS trg_audit_${table} ON ${table}`,
    `CREATE TRIGGER trg_audit_${table} AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION stock_sold_audit_fn()`,
  ];
}

export const GUARD_TRIGGER_SQL = [
  `DROP TRIGGER IF EXISTS trg_audit_guard_rows ON stock_sold_audit`,
  `CREATE TRIGGER trg_audit_guard_rows BEFORE UPDATE OR DELETE ON stock_sold_audit FOR EACH ROW EXECUTE FUNCTION stock_sold_audit_guard()`,
  `DROP TRIGGER IF EXISTS trg_audit_guard_truncate ON stock_sold_audit`,
  `CREATE TRIGGER trg_audit_guard_truncate BEFORE TRUNCATE ON stock_sold_audit FOR EACH STATEMENT EXECUTE FUNCTION stock_sold_audit_guard()`,
];

export async function ensureStockSoldAudit(): Promise<void> {
  await query(AUDIT_TABLE_SQL);
  for (const s of AUDIT_INDEX_SQL) await query(s);
  await query(AUDIT_FN_SQL);
  await query(AUDIT_GUARD_FN_SQL);
  for (const t of AUDITED_TABLES) for (const s of triggerStatements(t)) await query(s);
  for (const s of GUARD_TRIGGER_SQL) await query(s);
}
