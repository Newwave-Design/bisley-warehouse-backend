/**
 * Inventory Sync Service — Phase 3 (Event-Driven)
 * Pushes WMS inventory to Medusa only on key stock actions:
 * - Receiving supplier orders (check-in)
 * - Manual stock adjustments
 * - Scrap/damage adjustments
 *
 * No background polling — WMS is single source of truth for inventory levels.
 */

import { query } from '../db/index.js';
import { medusaPost } from './medusa-client.js';
import { getLogger } from './logger.js';

const logger = getLogger('inventory-sync');

export interface PushResult {
  sku: string;
  medusaVariantId?: string;
  medusaProductId?: string;
  newQuantity: number;
  reason: string;
  status: 'SYNCED' | 'FAILED' | 'SKIPPED';
  error?: string;
}

/**
 * Calculate available quantity for a SKU:
 * available_qty = SUM(quantity) - SUM(quantity_reserved)
 * Used to validate before pushing to Medusa
 */
export async function calculateAvailableQty(sku: string): Promise<number> {
  const result = await query(
    `SELECT 
       SUM(quantity)::int as total_qty,
       SUM(quantity_reserved)::int as reserved_qty
     FROM warehouse_inventory
     WHERE product_sku = $1`,
    [sku]
  );

  const row = result.rows[0];
  const totalQty = row.total_qty ?? 0;
  const reservedQty = row.reserved_qty ?? 0;
  const availableQty = Math.max(0, totalQty - reservedQty);

  return availableQty;
}


/**
 * Push a single SKU's inventory to Medusa
 * Called when stock actions occur: receiving, adjustments, scrap
 *
 * @param sku Product SKU
 * @param reason Why inventory changed (e.g. 'receiving_supplier_order', 'manual_adjustment', 'scrap')
 * @returns Result with success/failure and audit info
 */
export async function pushSkuToMedusa(sku: string, reason: string): Promise<PushResult> {
  try {
    // Fetch SKU's Medusa IDs from wms_products
    const skuResult = await query(
      `SELECT medusa_product_id, medusa_variant_id FROM wms_products WHERE product_sku = $1`,
      [sku]
    );

    if (skuResult.rows.length === 0) {
      logger.warn(`[${sku}] Not found in wms_products, skipping push`);
      return {
        sku,
        newQuantity: 0,
        reason,
        status: 'SKIPPED',
      };
    }

    const { medusa_product_id, medusa_variant_id } = skuResult.rows[0];

    if (!medusa_variant_id || !medusa_product_id) {
      logger.warn(`[${sku}] Missing Medusa IDs, skipping push`);
      return {
        sku,
        medusaVariantId: medusa_variant_id,
        medusaProductId: medusa_product_id,
        newQuantity: 0,
        reason,
        status: 'SKIPPED',
      };
    }

    // Calculate current available quantity
    const newQuantity = await calculateAvailableQty(sku);

    // Push to Medusa
    logger.info(`[${sku}] Pushing inventory (qty=${newQuantity}, reason=${reason})...`);
    await medusaPost(
      `/admin/products/${medusa_product_id}/variants/${medusa_variant_id}`,
      { stocked_quantity: newQuantity }
    );

    // Log success to inventory_sync_log
    await query(
      `INSERT INTO inventory_sync_log 
       (product_sku, medusa_variant_id, medusa_product_id, available_qty, stocked_qty_after, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, 'SYNCED', NOW(), NOW())`,
      [sku, medusa_variant_id, medusa_product_id, newQuantity]
    );

    // Update last sync timestamp
    await query(
      `UPDATE wms_products 
       SET last_synced_at = NOW(), last_sync_status = 'SYNCED'
       WHERE product_sku = $1`,
      [sku]
    );

    logger.info(`✓ [${sku}] Pushed successfully (qty=${newQuantity}, reason=${reason})`);

    return {
      sku,
      medusaVariantId: medusa_variant_id,
      medusaProductId: medusa_product_id,
      newQuantity,
      reason,
      status: 'SYNCED',
    };
  } catch (error: any) {
    const errorMsg = error.message || JSON.stringify(error);

    logger.error(`✗ [${sku}] Push failed: ${errorMsg}`);

    // Log failure to inventory_sync_log
    await query(
      `INSERT INTO inventory_sync_log 
       (product_sku, available_qty, status, error_message, created_at, updated_at)
       VALUES ($1, 0, 'FAILED', $2, NOW(), NOW())`,
      [sku, errorMsg]
    );

    return {
      sku,
      newQuantity: 0,
      reason,
      status: 'FAILED',
      error: errorMsg,
    };
  }
}
