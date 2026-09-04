/**
 * Permission catalog + effective-permission resolution.
 *
 * Access control model: every warehouse_users row belongs to one user_groups row.
 * A group's group_permissions rows define its defaults; user_permission_overrides
 * rows (if present) win over the group default for that one user.
 */
import { query } from '../db/index.js';

export interface PermissionDef {
  key: string;
  label: string;
  description: string;
}

export const PERMISSION_CATALOG: PermissionDef[] = [
  { key: 'system_admin', label: 'System & Sync', description: 'Sync products/inventory with Medusa, sync UPS shipping services, and other system-maintenance actions (seeding, purging, bulk bay generation).' },
  { key: 'manage_orders', label: 'Orders', description: 'Create, edit, and delete supplier orders and reorder thresholds.' },
  { key: 'manage_reorder_rules', label: 'Reorder Rules', description: 'Configure reorder rules and approve/delay/cancel pending reorders (incl. submitting to Genero).' },
  { key: 'manage_settings', label: 'Settings', description: 'Field mappings, shipping services, packaging profiles, and stock liability defaults.' },
  { key: 'manage_sku_mappings', label: 'SKU Mapping', description: 'Legacy SKU mapping tools.' },
  { key: 'manage_financials', label: 'Financials', description: 'View financial reports and edit per-SKU unit costs.' },
  { key: 'manage_error_log', label: 'Error Log', description: 'Bulk-resolve error log entries.' },
  { key: 'manage_users', label: 'Users & Permissions', description: 'Invite/manage users, groups, and permissions.' },
];

const PERMISSION_KEYS = new Set(PERMISSION_CATALOG.map(p => p.key));
export function isValidPermissionKey(key: string): boolean {
  return PERMISSION_KEYS.has(key);
}

// The demo token and the dev-mode auth fallback both use this synthetic id
// (see middleware/auth.ts) — treat it as a trusted, all-access internal caller.
const TRUSTED_SYNTHETIC_USER_ID = '1';

export async function getEffectivePermissions(userId: string | undefined): Promise<Record<string, boolean>> {
  const all: Record<string, boolean> = {};
  for (const p of PERMISSION_CATALOG) all[p.key] = false;
  if (!userId) return all;
  if (userId === TRUSTED_SYNTHETIC_USER_ID) {
    for (const p of PERMISSION_CATALOG) all[p.key] = true;
    return all;
  }

  const user = await query(`SELECT group_id FROM warehouse_users WHERE id = $1`, [userId]);
  const groupId = user.rows[0]?.group_id;
  if (groupId) {
    const groupPerms = await query(`SELECT permission_key, allowed FROM group_permissions WHERE group_id = $1`, [groupId]);
    for (const row of groupPerms.rows) all[row.permission_key] = row.allowed;
  }

  const overrides = await query(`SELECT permission_key, allowed FROM user_permission_overrides WHERE user_id = $1`, [userId]);
  for (const row of overrides.rows) all[row.permission_key] = row.allowed;

  return all;
}

export async function getEffectivePermission(userId: string | undefined, key: string): Promise<boolean> {
  const perms = await getEffectivePermissions(userId);
  return !!perms[key];
}
