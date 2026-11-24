/**
 * Dispatch notes the desk writes. They are the same records check-in and the scanner open by date.
 *
 * GET    /api/dispatch-notes
 * POST   /api/dispatch-notes
 * PUT    /api/dispatch-notes/:id
 * DELETE /api/dispatch-notes/:id
 */

import { closeDeliveryNote, reopenDeliveryNote } from '../../lib/delivery-note-close.js';
import express, { Response } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { deleteDispatchNote, DispatchNoteError, listDeliveryNotes, saveDispatchNote } from '../../lib/delivery-notes.js';

const router = express.Router();

function sendError(res: Response, err: unknown, fallback: string) {
  if (err instanceof DispatchNoteError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  return res.status(500).json({ error: fallback });
}

router.get('/', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ notes: await listDeliveryNotes() });
  } catch (err) {
    sendError(res, err, 'Failed to load dispatch notes');
  }
});

router.post('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const id = await saveDispatchNote(req.body || {});
    res.status(201).json({ id });
  } catch (err) {
    sendError(res, err, 'Failed to save the dispatch note');
  }
});

router.put('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const id = await saveDispatchNote({ ...req.body, id: req.params.id });
    res.json({ id });
  } catch (err) {
    sendError(res, err, 'Failed to save the dispatch note');
  }
});

// Close a delivery off as received. Needs everything scanned in, or acceptShortfall with a reason. X-Actor names who did it.
router.post('/:id/close', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const notes = await listDeliveryNotes();
    const note = notes.find((row) => row.id === req.params.id);
    if (!note) return res.status(404).json({ error: 'Delivery not found' });
    const actor = String(req.headers['x-actor'] || '').trim().slice(0, 120) || req.user?.email || req.user?.id || 'unknown';
    const result = await closeDeliveryNote(note, actor, { acceptShortfall: req.body?.accept_shortfall === true, note: req.body?.note });
    if (!result.ok) return res.status(result.status).json({ error: result.error, short: result.short || [] });
    return res.json({ closed: true, summary: result.summary, short: result.short, over: result.over });
  } catch (err) {
    sendError(res, err, 'Failed to close the delivery');
  }
});

router.post('/:id/reopen', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!(await reopenDeliveryNote(req.params.id))) return res.status(404).json({ error: 'That delivery is not closed' });
    return res.json({ reopened: true });
  } catch (err) {
    sendError(res, err, 'Failed to reopen the delivery');
  }
});

router.delete('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    await deleteDispatchNote(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err, 'Failed to delete the dispatch note');
  }
});

export default router;
