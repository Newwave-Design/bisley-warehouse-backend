/**
 * Genero Integration Routes
 *
 * Bisley New Wave API — field spec:
 *   POST with: account (required), order_id (optional), order_ref, name, sku (required), quantity (required)
 *   Returns:   account, order_id, order_ref, name, sku, quantity, status, bisley_order, Est_delivery
 *
 * Flow:
 *   1. POST /api/genero/submit/:orderId  — submit all line items for a WMS order
 *   2. POST /api/genero/poll             — re-poll all open lines for updated status/delivery
 *   3. GET  /api/genero/lines/:orderId   — get current line status for a WMS order
 */

import express, { Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { logError, logWarning, logInfo } from '../../lib/logger.js';

const router = express.Router();

const GENERO_API_URL = process.env.GENERO_API_URL ?? '';
const GENERO_ACCOUNT = process.env.GENERO_ACCOUNT_NO ?? 'NW123';

/** Call the Genero API for one line item and return the response */
async function callGeneroApi(payload: {
  account: string; order_id?: number; order_ref?: string;
  name?: string; sku: string; quantity: number;
}): Promise<any> {
  if (!GENERO_API_URL) {
    // Simulation mode when no URL is configured
    return {
      account: payload.account,
      order_id: payload.order_id ?? null,
      order_ref: payload.order_ref,
      name: payload.name,
      sku: payload.sku,
      quantity: payload.quantity,
      status: 'Pending',
      bisley_order: null,
      Est_delivery: null,
      _simulated: true,
    };
  }
  const res = await fetch(GENERO_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Genero API error ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * POST /api/genero/submit/:orderId
 * Submit all line items for a supplier order to the Genero API.
 * Creates genero_order_lines records with the response.
 */
router.post('/submit/:orderId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { orderId } = req.params;

    // Fetch the order and its line items
    const orderResult = await query(
      `SELECT * FROM supplier_orders WHERE id = $1`,
      [orderId]
    );
    if (!orderResult.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];

    const linesResult = await query(
      `SELECT * FROM order_line_items WHERE order_id = $1`,
      [orderId]
    );
    if (!linesResult.rows.length) return res.status(400).json({ error: 'No line items on this order' });

    const submitted: any[] = [];
    const errors: string[] = [];

    for (const line of linesResult.rows) {
      // Build the Bisley SKU: use medusa_sku if available (format: PRODUCTCODE-colourcode)
      const sku = line.medusa_sku ?? line.nw_code;
      if (!sku) { errors.push(`Line ${line.id}: no SKU`); continue; }

      try {
        // Check if we already have a genero line for this order_line_item (bisley_order already assigned)
        const existing = await query(
          `SELECT bisley_order FROM genero_order_lines WHERE order_line_item_id = $1 AND bisley_order IS NOT NULL LIMIT 1`,
          [line.id]
        );

        const payload = {
          account: GENERO_ACCOUNT,
          order_id: existing.rows[0]?.bisley_order ?? undefined,
          order_ref: order.order_number,
          name: line.product_name ?? line.nw_code,
          sku,
          quantity: line.quantity_ordered,
        };

        const response = await callGeneroApi(payload);

        // Upsert genero_order_lines row
        await query(`
          INSERT INTO genero_order_lines
            (supplier_order_id, order_line_item_id, account, order_ref, name, sku, quantity,
             bisley_order, genero_status, est_delivery, submitted_at, last_polled_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
          ON CONFLICT (order_line_item_id)
          DO UPDATE SET
            bisley_order   = COALESCE(EXCLUDED.bisley_order, genero_order_lines.bisley_order),
            genero_status  = EXCLUDED.genero_status,
            est_delivery   = EXCLUDED.est_delivery,
            last_polled_at = NOW(),
            poll_error     = NULL,
            updated_at     = NOW()
        `, [
          orderId, line.id, GENERO_ACCOUNT, order.order_number,
          line.product_name ?? line.nw_code, sku, line.quantity_ordered,
          response.bisley_order ?? null,
          response.status ?? null,
          response.Est_delivery ?? null,
        ]);

        submitted.push({ sku, bisley_order: response.bisley_order, status: response.status, est_delivery: response.Est_delivery });
      } catch (err: any) {
        errors.push(`${sku}: ${err.message?.slice(0, 100)}`);
        await query(`
          INSERT INTO genero_order_lines (supplier_order_id, order_line_item_id, account, sku, quantity, poll_error, submitted_at)
          VALUES ($1,$2,$3,$4,$5,$6,NOW())
          ON CONFLICT (order_line_item_id) DO UPDATE SET poll_error = $6, updated_at = NOW()
        `, [orderId, line.id, GENERO_ACCOUNT, sku, line.quantity_ordered, err.message?.slice(0, 500)]);
        await logError('GENERO_SUBMIT', err.message ?? 'Submit failed', { sku, order_number: order.order_number, order_id: orderId });
      }
    }

    // Update order status
    if (errors.length === 0) {
      await query(`UPDATE supplier_orders SET status = 'SUBMITTED', submitted_at = NOW() WHERE id = $1`, [orderId]);
    }

    res.json({ submitted: submitted.length, errors, simulated: !GENERO_API_URL });
  } catch (err: any) {
    console.error('Genero submit error:', err);
    res.status(500).json({ error: 'Submit failed', detail: err.message });
  }
});

/**
 * POST /api/genero/poll
 * Re-poll all open Genero lines (no bisley_order yet, or status not terminal).
 * Updates status and Est_delivery from the Genero API response.
 */
router.post('/poll', authMiddleware, async (req: AuthRequest, res: Response) => {
  const TERMINAL_STATUSES = new Set(['Received', 'Cancelled', 'Complete', 'Delivered']);
  try {
    // Find lines that are open (not terminal) or have never been polled
    const openLines = await query(`
      SELECT g.*, so.order_number
      FROM genero_order_lines g
      JOIN supplier_orders so ON so.id = g.supplier_order_id
      WHERE g.genero_status IS NULL
         OR g.genero_status NOT IN ('Received','Cancelled','Complete','Delivered')
      ORDER BY g.created_at
    `);

    if (!openLines.rows.length) {
      return res.json({ polled: 0, message: 'No open lines to poll' });
    }

    let polled = 0;
    let updated = 0;
    const errors: string[] = [];

    for (const line of openLines.rows) {
      try {
        const response = await callGeneroApi({
          account: line.account,
          order_id: line.bisley_order ?? undefined,
          order_ref: line.order_number,
          sku: line.sku,
          quantity: line.quantity,
        });
        polled++;

        const statusChanged = response.status !== line.genero_status;
        const deliveryChanged = response.Est_delivery !== line.est_delivery?.toISOString?.()?.split('T')[0];

        if (statusChanged || deliveryChanged || !line.bisley_order) {
          // Log status transitions as INFO events for the comms trail
          if (statusChanged && response.status) {
            await logInfo('GENERO_POLL', `Status: ${line.genero_status ?? 'unknown'} → ${response.status}`,
              { sku: line.sku, bisley_order: response.bisley_order ?? line.bisley_order, order_number: line.order_number });
          }
          if (deliveryChanged && response.Est_delivery) {
            await logInfo('GENERO_POLL', `Delivery date updated: ${response.Est_delivery}`,
              { sku: line.sku, bisley_order: line.bisley_order, prev: line.est_delivery, new: response.Est_delivery });
          }
          await query(`
            UPDATE genero_order_lines SET
              bisley_order   = COALESCE($1, bisley_order),
              genero_status  = $2,
              est_delivery   = $3,
              last_polled_at = NOW(),
              poll_error     = NULL,
              updated_at     = NOW()
            WHERE id = $4
          `, [response.bisley_order ?? null, response.status, response.Est_delivery ?? null, line.id]);
          if (statusChanged) updated++;
        } else {
          await query(`UPDATE genero_order_lines SET last_polled_at = NOW() WHERE id = $1`, [line.id]);
        }
      } catch (err: any) {
        errors.push(`${line.sku}: ${err.message?.slice(0, 100)}`);
        await logError('GENERO_POLL', err.message ?? 'Poll failed', { sku: line.sku, bisley_order: line.bisley_order, order_number: line.order_number });
        await query(`UPDATE genero_order_lines SET poll_error = $1, last_polled_at = NOW() WHERE id = $2`,
          [err.message?.slice(0, 500), line.id]);
      }
    }

    res.json({ polled, updated, errors: errors.slice(0, 10), simulated: !GENERO_API_URL });
  } catch (err: any) {
    console.error('Genero poll error:', err);
    res.status(500).json({ error: 'Poll failed', detail: err.message });
  }
});

/** GET /api/genero/lines/:orderId — get current Genero line status for a WMS order */
router.get('/lines/:orderId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(`
      SELECT g.*, oli.nw_code, oli.colour, oli.family
      FROM genero_order_lines g
      LEFT JOIN order_line_items oli ON oli.id = g.order_line_item_id
      WHERE g.supplier_order_id = $1
      ORDER BY g.created_at
    `, [req.params.orderId]);
    res.json({ lines: result.rows, total: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch Genero lines' });
  }
});

/** GET /api/genero/config — show current config (URL and account, no secrets) */
router.get('/config', authMiddleware, (_req: AuthRequest, res: Response) => {
  res.json({
    api_url: GENERO_API_URL || '(not configured — set GENERO_API_URL env var)',
    account: GENERO_ACCOUNT,
    simulation_mode: !GENERO_API_URL,
  });
});

export default router;
