/**
 * Inventory Sync Service — Phase 3
 * Syncs WMS available inventory to Medusa variant stocked_quantity
 * Runs every 5 minutes as a background job
 */

import { query } from '../db/index.js';
import { medusaPost, MEDUSA_URL } from './medusa-client.js';
import { getLogger } from './logger.js';

const logger = getLogger('inventory-sync');

export interface SyncResult {
  sku: string;
  medusaVariantId: string;
  medusaProductId: string;
  availableQty: number;
  status: 'SYNCED' | 'FAILED';
  error?: string;
}

/**
 * Calculate available quantity for a SKU:
 * available_qty = SUM(quantity) - SUM(quantity_reserved)
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
 * Sync all SKUs with medusa_variant_id to Medusa (once per cycle)
 */
export async function syncAllInventoryToMedusa(): Promise<SyncResult[]> {
  try {
    logger.info('Starting inventory sync cycle...');

    // Find all SKUs with medusa_variant_id
    const skusResult = await query(
      `SELECT DISTINCT product_sku, medusa_product_id, medusa_variant_id
       FROM wms_products
       WHERE medusa_variant_id IS NOT NULL
       ORDER BY product_sku`
    );

    const results: SyncResult[] = [];
    let successCount = 0;
    let failureCount = 0;

    for (const row of skusResult.rows) {
      const { product_sku, medusa_product_id, medusa_variant_id } = row;

      try {
        // Calculate current available qty
        const availableQty = await calculateAvailableQty(product_sku);

        // Get previous stocked_qty for comparison
        const previousResult = await query(
          `SELECT stocked_qty_after FROM inventory_sync_log
           WHERE product_sku = $1 AND status = 'SYNCED'
           ORDER BY created_at DESC LIMIT 1`,
          [product_sku]
        );

        const previousStockedQty = previousResult.rows[0]?.stocked_qty_after ?? 0;

        // Skip if no change (optimization)
        if (availableQty === previousStockedQty) {
          logger.debug(`[${product_sku}] No change, skipping sync`);
          continue;
        }

        // Call Medusa API
        logger.info(`[${product_sku}] Syncing available_qty=${availableQty}...`);
        const response = await medusaPost(
          `/admin/products/${medusa_product_id}/variants/${medusa_variant_id}`,
          { stocked_quantity: availableQty }
        );

        const newStockedQty = response.variant?.stocked_quantity ?? availableQty;

        // Log success
        await query(
          `INSERT INTO inventory_sync_log 
           (product_sku, medusa_variant_id, medusa_product_id, available_qty, stocked_qty_before, stocked_qty_after, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'SYNCED', NOW(), NOW())`,
          [product_sku, medusa_variant_id, medusa_product_id, availableQty, previousStockedQty, newStockedQty]
        );

        // Update wms_products
        await query(
          `UPDATE wms_products SET last_synced_at = NOW(), last_sync_status = 'SUCCESS'
           WHERE product_sku = $1`,
          [product_sku]
        );

        successCount++;
        results.push({
          sku: product_sku,
          medusaVariantId: medusa_variant_id,
          medusaProductId: medusa_product_id,
          availableQty,
          status: 'SYNCED',
        });

        logger.info(`✓ [${product_sku}] Synced successfully (available=${availableQty})`);

        // Rate limit: 10 calls/min = 100ms between calls
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error: any) {
        failureCount++;
        const errorMsg = error.message || JSON.stringify(error);

        // Log failure
        await query(
          `INSERT INTO inventory_sync_log 
           (product_sku, medusa_variant_id, medusa_product_id, available_qty, status, error_message, retry_count, created_at, updated_at)
           VALUES ($1, $2, $3, 0, 'FAILED', $4, 0, NOW(), NOW())`,
          [product_sku, row.medusa_variant_id, row.medusa_product_id, errorMsg]
        );

        // Update wms_products
        await query(
          `UPDATE wms_products SET last_sync_status = 'FAILED'
           WHERE product_sku = $1`,
          [product_sku]
        );

        results.push({
          sku: product_sku,
          medusaVariantId: row.medusa_variant_id,
          medusaProductId: row.medusa_product_id,
          availableQty: 0,
          status: 'FAILED',
          error: errorMsg,
        });

        logger.error(`✗ [${product_sku}] Sync failed: ${errorMsg}`);
      }
    }

    logger.info(`Inventory sync cycle complete: ${successCount} success, ${failureCount} failed`);
    return results;
  } catch (error: any) {
    logger.error('Fatal error in inventory sync cycle:', error);
    throw error;
  }
}

/**
 * Retry failed syncs with exponential backoff
 * Runs every 5 minutes, attempts retries for items that failed in the last cycle
 */
export async function retryFailedSyncs(): Promise<SyncResult[]> {
  try {
    const failedResult = await query(
      `SELECT product_sku, medusa_product_id, medusa_variant_id, error_message, retry_count
       FROM inventory_sync_log
       WHERE status = 'FAILED' AND retry_count < 5
         AND (last_retry_at IS NULL OR last_retry_at < NOW() - INTERVAL '5 minutes' * POW(2, retry_count))
       ORDER BY retry_count ASC, created_at ASC
       LIMIT 10`  // Retry at most 10 items per cycle
    );

    const results: SyncResult[] = [];

    for (const row of failedResult.rows) {
      try {
        const availableQty = await calculateAvailableQty(row.product_sku);
        await medusaPost(
          `/admin/products/${row.medusa_product_id}/variants/${row.medusa_variant_id}`,
          { stocked_quantity: availableQty }
        );

        // Mark as synced
        await query(
          `UPDATE inventory_sync_log
           SET status = 'SYNCED', last_retry_at = NOW()
           WHERE product_sku = $1 AND status = 'FAILED'
           ORDER BY created_at DESC LIMIT 1`,
          [row.product_sku]
        );

        logger.info(`✓ Retry successful for [${row.product_sku}]`);
        results.push({
          sku: row.product_sku,
          medusaVariantId: row.medusa_variant_id,
          medusaProductId: row.medusa_product_id,
          availableQty,
          status: 'SYNCED',
        });
      } catch (error: any) {
        // Increment retry count
        await query(
          `UPDATE inventory_sync_log
           SET retry_count = retry_count + 1, last_retry_at = NOW(), error_message = $1, updated_at = NOW()
           WHERE product_sku = $2 AND status = 'FAILED'
           ORDER BY created_at DESC LIMIT 1`,
          [error.message, row.product_sku]
        );

        logger.warn(`✗ Retry #${row.retry_count + 1} failed for [${row.product_sku}]: ${error.message}`);
        results.push({
          sku: row.product_sku,
          medusaVariantId: row.medusa_variant_id,
          medusaProductId: row.medusa_product_id,
          availableQty: 0,
          status: 'FAILED',
          error: error.message,
        });
      }

      // Rate limit
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return results;
  } catch (error: any) {
    logger.error('Fatal error in retry cycle:', error);
    throw error;
  }
}
