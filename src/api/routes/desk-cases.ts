/**
 * The customer desk's one hand-off for an enquiry: PUT sends what the desk knows, GET reads where the case stands.
 * Keyed on the desk's enquiry id, so a resend updates the same case.
 */
import express, { Response } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth.js';
import { DeskCaseError, deskCaseStatus, upsertDeskCase } from '../../lib/desk-case.js';

const router = express.Router();
router.use(authMiddleware);

const text = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max) || undefined;

router.put('/:caseId', async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body || {};
    const result = await upsertDeskCase(req.params.caseId, {
      pickListId: String(body.pick_list_id || ''),
      kind: String(body.kind || '') as 'damage' | 'return' | 'refund',
      reason: text(body.reason, 40),
      note: text(body.note, 800),
      ref: text(body.ref, 60),
      requestedBy: text(body.requested_by, 120),
      wants: text(body.wants, 20),
      reportedAt: text(body.reported_at, 40),
    });
    return res.status(result.linked ? 200 : 202).json(result);
  } catch (error) {
    if (error instanceof DeskCaseError) return res.status(error.status).json({ error: error.message });
    console.error('Desk case failed', error instanceof Error ? error.message : error);
    return res.status(500).json({ error: 'Could not record that case.' });
  }
});

router.get('/:caseId', async (req: AuthRequest, res: Response) => {
  try {
    return res.json(await deskCaseStatus(req.params.caseId));
  } catch (error) {
    console.error('Reading a desk case failed', error instanceof Error ? error.message : error);
    return res.status(500).json({ error: 'Could not read that case.' });
  }
});

export default router;
