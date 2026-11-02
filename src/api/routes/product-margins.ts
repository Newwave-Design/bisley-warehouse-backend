/**
 * One row per listed product (not per colour).
 * Prices, packaging, courier cost and the customer shipping charge come from SmartSuite.
 * Cost comes from Chris Miller's order spreadsheet where that product has a buy price.
 */
import express from 'express';
import { readFileSync } from 'fs';
import { authMiddleware } from '../../middleware/auth.js';

const router = express.Router();
router.use(authMiddleware);

const rows = JSON.parse(
  readFileSync(new URL('../../data/product-margins.json', import.meta.url), 'utf8')
);

router.get('/', (_req, res) => {
  res.json({ products: rows });
});

export default router;
