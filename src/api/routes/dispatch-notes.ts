/**
 * Dispatch notes the desk writes. They are the same records check-in and the scanner open by date.
 *
 * GET    /api/dispatch-notes
 * POST   /api/dispatch-notes
 * PUT    /api/dispatch-notes/:id
 * DELETE /api/dispatch-notes/:id
 */

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

router.delete('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    await deleteDispatchNote(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err, 'Failed to delete the dispatch note');
  }
});

export default router;
