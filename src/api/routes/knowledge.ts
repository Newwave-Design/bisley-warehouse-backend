/**
 * Customer-service knowledge base.
 * Articles are reusable answers. Spare parts classify a SKU; warehouse_inventory keeps the quantity.
 *
 * GET /api/knowledge/export is the document for an assistant: published articles and active spares,
 * with catalogue image/description filled in when the spare record leaves them blank, and live stock.
 */

import { Router, Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware, requirePermission, type AuthRequest } from '../../middleware/auth.js';

const router = Router();
router.use(authMiddleware);
router.use(requirePermission('manage_crm'));

const CATEGORIES = ['common_query', 'delivery', 'returns', 'product_help', 'other'] as const;

function textList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '';
  return [...new Set(raw.split(',').map(part => part.trim()).filter(Boolean))].slice(0, 30);
}

function plain(html: unknown): string | null {
  if (typeof html !== 'string') return null;
  const text = html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

const SPARE_SELECT = `
  SELECT s.id, s.sku, s.title,
         COALESCE(NULLIF(s.description, ''), p.product_description) AS description,
         COALESCE(NULLIF(s.image_url, ''), p.variant_thumbnail, p.product_thumbnail) AS image_url,
         s.notes, s.is_active, s.created_by, s.updated_by, s.created_at, s.updated_at,
         (p.variant_sku IS NOT NULL) AS in_catalogue,
         COALESCE(stock.on_hand, 0)::int AS stock_on_hand,
         COALESCE(stock.available, 0)::int AS stock_available
  FROM spare_parts s
  LEFT JOIN LATERAL (
    SELECT variant_sku, product_description, variant_thumbnail, product_thumbnail
    FROM wms_products
    WHERE variant_sku = s.sku AND is_archived = false
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1
  ) p ON true
  LEFT JOIN LATERAL (
    SELECT SUM(quantity) AS on_hand, SUM(quantity_available) AS available
    FROM warehouse_inventory
    WHERE product_sku = s.sku
  ) stock ON true
`;

router.get('/export', async (_req: AuthRequest, res: Response) => {
  try {
    const [articles, spares] = await Promise.all([
      query(
        `SELECT title, question, answer, category, tags, related_skus, updated_at
         FROM knowledge_articles WHERE is_published ORDER BY category, title`
      ),
      query(`${SPARE_SELECT} WHERE s.is_active ORDER BY s.sku`),
    ]);
    return res.json({
      generated_at: new Date().toISOString(),
      articles: articles.rows.map(row => ({
        title: row.title,
        question: row.question,
        answer: row.answer,
        category: row.category,
        tags: row.tags,
        related_skus: row.related_skus,
        updated_at: row.updated_at,
      })),
      spare_parts: spares.rows.map(row => ({
        sku: row.sku,
        title: row.title,
        description: plain(row.description),
        image_url: row.image_url,
        notes: row.notes,
        in_catalogue: row.in_catalogue,
        stock_on_hand: row.stock_on_hand,
        stock_available: row.stock_available,
        updated_at: row.updated_at,
      })),
    });
  } catch (error) {
    console.error('Knowledge export error:', error);
    return res.status(500).json({ error: 'Failed to export knowledge base' });
  }
});

router.get('/catalogue', async (req: AuthRequest, res: Response) => {
  try {
    const sku = cleanText(req.query.sku, 100);
    if (!sku) return res.status(400).json({ error: 'sku is required' });
    const product = await query(
      `SELECT product_title, variant_title, product_description, variant_thumbnail, product_thumbnail
       FROM wms_products WHERE variant_sku = $1 AND is_archived = false
       ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
      [sku]
    );
    const stock = await query(
      `SELECT COALESCE(SUM(quantity), 0)::int AS stock_on_hand,
              COALESCE(SUM(quantity_available), 0)::int AS stock_available
       FROM warehouse_inventory WHERE product_sku = $1`,
      [sku]
    );
    const row = product.rows[0];
    return res.json({
      sku,
      found: Boolean(row) || Number(stock.rows[0].stock_on_hand) > 0,
      in_catalogue: Boolean(row),
      title: row ? [row.product_title, row.variant_title].filter(Boolean).join(' — ') : null,
      description: plain(row?.product_description),
      image_url: row?.variant_thumbnail || row?.product_thumbnail || null,
      stock_on_hand: stock.rows[0].stock_on_hand,
      stock_available: stock.rows[0].stock_available,
    });
  } catch (error) {
    console.error('Knowledge catalogue lookup error:', error);
    return res.status(500).json({ error: 'Failed to look up SKU' });
  }
});

router.get('/articles', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT * FROM knowledge_articles ORDER BY updated_at DESC`
    );
    return res.json({ articles: result.rows });
  } catch (error) {
    console.error('Knowledge articles list error:', error);
    return res.status(500).json({ error: 'Failed to load articles' });
  }
});

router.post('/articles', async (req: AuthRequest, res: Response) => {
  try {
    const title = cleanText(req.body?.title, 200);
    const answer = cleanText(req.body?.answer, 8000);
    const question = cleanText(req.body?.question, 1000) || null;
    const category = (CATEGORIES as readonly string[]).includes(req.body?.category) ? req.body.category : 'common_query';
    if (!title || !answer) return res.status(400).json({ error: 'A title and an answer are required' });
    const result = await query(
      `INSERT INTO knowledge_articles
         (title, question, answer, category, tags, related_skus, is_published, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       RETURNING *`,
      [title, question, answer, category, textList(req.body?.tags), textList(req.body?.related_skus), req.body?.is_published !== false, req.user?.email ?? null]
    );
    return res.status(201).json({ article: result.rows[0] });
  } catch (error) {
    console.error('Knowledge article create error:', error);
    return res.status(500).json({ error: 'Failed to save article' });
  }
});

router.patch('/articles/:id', async (req: AuthRequest, res: Response) => {
  try {
    const title = cleanText(req.body?.title, 200);
    const answer = cleanText(req.body?.answer, 8000);
    const question = cleanText(req.body?.question, 1000) || null;
    const category = (CATEGORIES as readonly string[]).includes(req.body?.category) ? req.body.category : 'common_query';
    if (!title || !answer) return res.status(400).json({ error: 'A title and an answer are required' });
    const result = await query(
      `UPDATE knowledge_articles SET
         title = $2, question = $3, answer = $4, category = $5, tags = $6, related_skus = $7,
         is_published = $8, updated_by = $9, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, title, question, answer, category, textList(req.body?.tags), textList(req.body?.related_skus), req.body?.is_published !== false, req.user?.email ?? null]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Article not found' });
    return res.json({ article: result.rows[0] });
  } catch (error) {
    console.error('Knowledge article update error:', error);
    return res.status(500).json({ error: 'Failed to update article' });
  }
});

router.delete('/articles/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(`DELETE FROM knowledge_articles WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Article not found' });
    return res.json({ ok: true });
  } catch (error) {
    console.error('Knowledge article delete error:', error);
    return res.status(500).json({ error: 'Failed to delete article' });
  }
});

router.get('/spares', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(`${SPARE_SELECT} ORDER BY s.sku`);
    return res.json({
      spares: result.rows.map(row => ({ ...row, description: plain(row.description) })),
    });
  } catch (error) {
    console.error('Spare parts list error:', error);
    return res.status(500).json({ error: 'Failed to load spare parts' });
  }
});

router.post('/spares', async (req: AuthRequest, res: Response) => {
  try {
    const sku = cleanText(req.body?.sku, 100);
    const title = cleanText(req.body?.title, 255);
    if (!sku || !title) return res.status(400).json({ error: 'A SKU and a title are required' });
    const result = await query(
      `INSERT INTO spare_parts (sku, title, description, image_url, notes, is_active, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING id`,
      [
        sku, title,
        cleanText(req.body?.description, 8000) || null,
        cleanText(req.body?.image_url, 500) || null,
        cleanText(req.body?.notes, 4000) || null,
        req.body?.is_active !== false,
        req.user?.email ?? null,
      ]
    );
    const saved = await query(`${SPARE_SELECT} WHERE s.id = $1`, [result.rows[0].id]);
    return res.status(201).json({ spare: { ...saved.rows[0], description: plain(saved.rows[0].description) } });
  } catch (error: any) {
    if (error?.code === '23505') return res.status(409).json({ error: 'That SKU is already on the spare parts list' });
    console.error('Spare part create error:', error);
    return res.status(500).json({ error: 'Failed to save spare part' });
  }
});

router.patch('/spares/:id', async (req: AuthRequest, res: Response) => {
  try {
    const sku = cleanText(req.body?.sku, 100);
    const title = cleanText(req.body?.title, 255);
    if (!sku || !title) return res.status(400).json({ error: 'A SKU and a title are required' });
    const result = await query(
      `UPDATE spare_parts SET
         sku = $2, title = $3, description = $4, image_url = $5, notes = $6,
         is_active = $7, updated_by = $8, updated_at = NOW()
       WHERE id = $1 RETURNING id`,
      [
        req.params.id, sku, title,
        cleanText(req.body?.description, 8000) || null,
        cleanText(req.body?.image_url, 500) || null,
        cleanText(req.body?.notes, 4000) || null,
        req.body?.is_active !== false,
        req.user?.email ?? null,
      ]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Spare part not found' });
    const saved = await query(`${SPARE_SELECT} WHERE s.id = $1`, [result.rows[0].id]);
    return res.json({ spare: { ...saved.rows[0], description: plain(saved.rows[0].description) } });
  } catch (error: any) {
    if (error?.code === '23505') return res.status(409).json({ error: 'That SKU is already on the spare parts list' });
    console.error('Spare part update error:', error);
    return res.status(500).json({ error: 'Failed to update spare part' });
  }
});

router.delete('/spares/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(`DELETE FROM spare_parts WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Spare part not found' });
    return res.json({ ok: true });
  } catch (error) {
    console.error('Spare part delete error:', error);
    return res.status(500).json({ error: 'Failed to delete spare part' });
  }
});

export default router;
