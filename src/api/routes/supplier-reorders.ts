/**
 * Supplier Re-orders — one row per SKU on every customer order; tick rows and email them to a supplier as a spreadsheet.
 *
 * Rows are derived live from pick_list_items (kits expand to their components) — nothing is stored per row
 * until a send, so sent status comes from supplier_reorder_send_lines.
 * Spreadsheets carry the supplier's own part number + colour code (wms_products.supplier_part_code /
 * supplier_colour_code); rows without one can't be sent.
 *
 * GET  /api/supplier-reorders            — all rows with last-sent info
 * GET  /api/supplier-reorders/suppliers  — saved suppliers
 * POST /api/supplier-reorders/send       — { supplier: { email, name? }, lines: [{ pick_list_item_id, sku }] }
 *      Builds the .xlsx (SKU, Title, Colour, Full SKU, Quantity — one row per supplier SKU + colour, quantities summed), emails it via Medusa's mailer
 *      (POST /admin/supplier-orders/send), saves the supplier, and records the send.
 *
 * Replaces the threshold-driven Pending Reorders flow (kept in the code, hidden from the nav).
 */

import express, { Response } from 'express';
import XLSX from 'xlsx';
import { query, getPool } from '../../db/index.js';
import { authMiddleware, requirePermission, AuthRequest } from '../../middleware/auth.js';
import { medusaPost } from '../../lib/medusa-client.js';

const router = express.Router();

interface ReorderLine {
  key: string;
  pick_list_item_id: string;
  sku: string;
  title: string;
  colour: string;
  supplier_sku: string | null;
  supplier_colour: string;
  supplier_inferred: boolean;
  quantity: number;
  pick_list_number: string;
  ordered_at: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINES = 2000;

async function buildLines(): Promise<ReorderLine[]> {
  const items = await query(`
    SELECT pli.id AS pick_list_item_id, pli.product_sku, pli.colour_code AS item_colour,
           pli.quantity_required, pl.pick_list_number, pl.created_at AS ordered_at,
           wp.product_title, wp.colour_name, wp.colour_code AS wp_colour, wp.is_kit, wp.kit_components,
           wp.supplier_part_code, wp.supplier_colour_code, wp.supplier_code_source
    FROM pick_list_items pli
    JOIN pick_lists pl ON pl.id = pli.pick_list_id
    LEFT JOIN LATERAL (
      SELECT product_title, colour_name, colour_code, is_kit, kit_components, supplier_part_code, supplier_colour_code, supplier_code_source
      FROM wms_products WHERE variant_sku = pli.product_sku ORDER BY is_archived LIMIT 1
    ) wp ON true
    WHERE pl.status <> 'CANCELLED' AND NOT pl.is_sandbox AND NOT pl.is_archived
      AND NOT pli.is_sandbox AND NOT pli.is_archived
      AND pli.product_sku NOT LIKE 'FINSAMPLE-%'
    ORDER BY pl.created_at DESC, pli.line_number
  `);

  type Comp = { sku: string; required_quantity: number };
  const componentSkus = new Set<string>();
  for (const r of items.rows) {
    if (r.is_kit && Array.isArray(r.kit_components)) {
      for (const c of r.kit_components as Comp[]) componentSkus.add(c.sku);
    }
  }
  const compInfo = new Map<string, { title: string; colour: string; supplier_sku: string | null; supplier_colour: string; inferred: boolean }>();
  if (componentSkus.size) {
    const cr = await query(
      `SELECT DISTINCT ON (variant_sku) variant_sku, product_title, colour_name, colour_code, supplier_part_code, supplier_colour_code, supplier_code_source
       FROM wms_products WHERE variant_sku = ANY($1) ORDER BY variant_sku, is_archived`,
      [[...componentSkus]]
    );
    for (const c of cr.rows) {
      compInfo.set(c.variant_sku, {
        title: c.product_title ?? '',
        colour: c.colour_name || c.colour_code || '',
        supplier_sku: c.supplier_part_code ?? null,
        supplier_colour: c.supplier_colour_code ?? '',
        inferred: c.supplier_code_source === 'inferred',
      });
    }
  }

  const lines: ReorderLine[] = [];
  for (const r of items.rows) {
    const base = {
      pick_list_item_id: r.pick_list_item_id as string,
      pick_list_number: r.pick_list_number as string,
      ordered_at: new Date(r.ordered_at).toISOString(),
    };
    const qty = Number(r.quantity_required) || 0;
    if (r.is_kit && Array.isArray(r.kit_components) && r.kit_components.length) {
      for (const c of r.kit_components as Comp[]) {
        const info = compInfo.get(c.sku);
        lines.push({
          ...base,
          key: `${base.pick_list_item_id}|${c.sku}`,
          sku: c.sku,
          title: info?.title || c.sku,
          colour: info?.colour ?? '',
          supplier_sku: info?.supplier_sku ?? null,
          supplier_colour: info?.supplier_colour ?? '',
          supplier_inferred: info?.inferred ?? false,
          quantity: qty * (Number(c.required_quantity) || 1),
        });
      }
    } else {
      lines.push({
        ...base,
        key: `${base.pick_list_item_id}|${r.product_sku}`,
        sku: r.product_sku,
        title: r.product_title || r.product_sku,
        colour: r.colour_name || r.wp_colour || r.item_colour || '',
        supplier_sku: r.supplier_part_code ?? null,
        supplier_colour: r.supplier_colour_code ?? '',
        supplier_inferred: r.supplier_code_source === 'inferred',
        quantity: qty,
      });
    }
  }
  return lines;
}

router.get('/', authMiddleware, requirePermission('manage_orders'), async (_req: AuthRequest, res: Response) => {
  try {
    const [lines, sent] = await Promise.all([
      buildLines(),
      query(`
        SELECT DISTINCT ON (l.pick_list_item_id, l.sku)
               l.pick_list_item_id, l.sku, s.sent_at, s.sent_to, sp.name AS supplier_name
        FROM supplier_reorder_send_lines l
        JOIN supplier_reorder_sends s ON s.id = l.send_id
        JOIN suppliers sp ON sp.id = s.supplier_id
        ORDER BY l.pick_list_item_id, l.sku, s.sent_at DESC
      `),
    ]);
    const sentByKey = new Map<string, any>();
    for (const s of sent.rows) sentByKey.set(`${s.pick_list_item_id}|${s.sku}`, s);

    res.json({
      lines: lines.map(l => {
        const s = sentByKey.get(l.key);
        return {
          ...l,
          sent_at: s ? new Date(s.sent_at).toISOString() : null,
          sent_to: s ? (s.supplier_name || s.sent_to) : null,
        };
      }),
    });
  } catch (err: any) {
    console.error('[supplier-reorders] list failed:', err);
    res.status(500).json({ error: 'Failed to load re-order lines' });
  }
});

router.get('/suppliers', authMiddleware, requirePermission('manage_orders'), async (_req: AuthRequest, res: Response) => {
  try {
    const r = await query(`SELECT id, name, email FROM suppliers ORDER BY COALESCE(name, email)`);
    res.json({ suppliers: r.rows });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load suppliers' });
  }
});

// Stops a cell starting with = + - @ being evaluated as a formula when the supplier opens the file
function safeCell(v: string): string {
  return /^[=+\-@]/.test(v) ? `'${v}` : v;
}

router.post('/send', authMiddleware, requirePermission('manage_orders'), async (req: AuthRequest, res: Response) => {
  try {
    const email = String(req.body?.supplier?.email ?? '').trim();
    const name = String(req.body?.supplier?.name ?? '').trim().slice(0, 255);
    const requested = req.body?.lines;

    if (!EMAIL_RE.test(email) || email.length > 255) return res.status(400).json({ error: 'Enter a valid supplier email address' });
    if (!Array.isArray(requested) || !requested.length) return res.status(400).json({ error: 'Tick at least one row' });
    if (requested.length > MAX_LINES) return res.status(400).json({ error: `Send at most ${MAX_LINES} rows at a time` });

    const wantedKeys = new Set<string>();
    for (const l of requested) {
      if (!UUID_RE.test(String(l?.pick_list_item_id)) || typeof l?.sku !== 'string') {
        return res.status(400).json({ error: 'Invalid line' });
      }
      wantedKeys.add(`${l.pick_list_item_id}|${l.sku}`);
    }

    // Quantities and titles come from the DB, not the client
    const all = await buildLines();
    const selected = all.filter(l => wantedKeys.has(l.key));
    if (selected.length !== wantedKeys.size) {
      return res.status(409).json({ error: 'Some rows no longer exist — refresh and try again' });
    }

    const missing = [...new Set(selected.filter(l => !l.supplier_sku).map(l => l.sku))];
    if (missing.length) {
      return res.status(422).json({ error: `No supplier SKU for: ${missing.join(', ')}. Untick these rows.` });
    }

    // One row per supplier SKU + colour, quantities summed across the ticked order lines
    const grouped = new Map<string, { sku: string; colour: string; title: string; quantity: number }>();
    for (const l of selected) {
      const key = `${l.supplier_sku}|${l.supplier_colour}`;
      const g = grouped.get(key);
      if (g) g.quantity += l.quantity;
      else grouped.set(key, { sku: l.supplier_sku!, colour: l.supplier_colour, title: l.title, quantity: l.quantity });
    }
    const sheetRows = [...grouped.values()].sort((a, b) => a.sku.localeCompare(b.sku) || a.colour.localeCompare(b.colour));

    const aoa: (string | number)[][] = [['SKU', 'Title', 'Colour', 'Full SKU', 'Quantity']];
    for (const r of sheetRows) {
      const full = r.colour ? `${r.sku}-${r.colour}` : r.sku;
      aoa.push([safeCell(r.sku), safeCell(r.title), safeCell(r.colour), safeCell(full), r.quantity]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 22 }, { wch: 50 }, { wch: 14 }, { wch: 30 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Re-order');
    const buffer: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const today = new Date().toISOString().slice(0, 10);
    const filename = `bisley-reorder-${today}.xlsx`;

    // Mail first: a send that never went out must not be recorded as sent
    await medusaPost('/admin/supplier-orders/send', {
      to: email,
      supplier_name: name || null,
      filename,
      line_count: sheetRows.length,
      content_base64: buffer.toString('base64'),
    });

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const sup = await client.query(
        `INSERT INTO suppliers (name, email) VALUES (NULLIF($1,''), $2)
         ON CONFLICT ((LOWER(email))) DO UPDATE
           SET name = COALESCE(NULLIF(EXCLUDED.name,''), suppliers.name), updated_at = NOW()
         RETURNING id`,
        [name, email]
      );
      const send = await client.query(
        `INSERT INTO supplier_reorder_sends (supplier_id, sent_to, sent_by, line_count)
         VALUES ($1,$2,$3,$4) RETURNING id, sent_at`,
        [sup.rows[0].id, email, req.user?.email ?? null, selected.length]
      );
      for (const l of selected) {
        await client.query(
          `INSERT INTO supplier_reorder_send_lines (send_id, pick_list_item_id, sku, quantity) VALUES ($1,$2,$3,$4)`,
          [send.rows[0].id, l.pick_list_item_id, l.sku, l.quantity]
        );
      }
      await client.query('COMMIT');
      res.json({ sent: selected.length, sent_at: new Date(send.rows[0].sent_at).toISOString(), supplier_id: sup.rows[0].id });
    } catch (dbErr) {
      await client.query('ROLLBACK');
      console.error('[supplier-reorders] email sent but recording failed:', dbErr);
      res.status(500).json({ error: 'Email was sent but could not be recorded — do not re-send; contact support' });
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error('[supplier-reorders] send failed:', err);
    // Medusa's own message (e.g. missing sender env var) is what tells the user what to fix
    const reason = String(err?.message ?? '').replace(/^Medusa API error: \d+ /, '').slice(0, 300);
    res.status(502).json({ error: `Could not send the email — nothing was recorded${reason ? `: ${reason}` : ''}` });
  }
});

export default router;
