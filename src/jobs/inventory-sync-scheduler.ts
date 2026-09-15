/**
 * Inventory Sync Scheduler — Phase 3
 * Background job runner for periodic inventory syncs
 * Runs every 5 minutes by default
 */

import { syncAllInventoryToMedusa, retryFailedSyncs } from '../lib/inventory-sync-service.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('inventory-sync-scheduler');

let isRunning = false;
let intervalHandle: NodeJS.Timeout | null = null;

/**
 * Start the inventory sync scheduler (every 5 minutes)
 */
export function startInventorySyncScheduler() {
  // Run immediately on startup
  scheduleSyncCycle();

  // Then run every 5 minutes
  intervalHandle = setInterval(() => {
    scheduleSyncCycle();
  }, 5 * 60 * 1000);

  logger.info('Inventory sync scheduler started (every 5 minutes)');
}

/**
 * Stop the inventory sync scheduler (useful for graceful shutdown)
 */
export function stopInventorySyncScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('Inventory sync scheduler stopped');
  }
}

/**
 * Execute one complete sync cycle (main + retry passes)
 */
async function scheduleSyncCycle() {
  if (isRunning) {
    logger.warn('Previous sync cycle still running, skipping...');
    return;
  }

  isRunning = true;
  try {
    logger.info('=== Inventory Sync Cycle Starting ===');
    const startTime = Date.now();

    // Main sync pass: sync all changed inventory
    const syncResults = await syncAllInventoryToMedusa();
    const syncSuccessCount = syncResults.filter(r => r.status === 'SYNCED').length;
    const syncFailureCount = syncResults.filter(r => r.status === 'FAILED').length;
    logger.info(`Sync pass complete: ${syncSuccessCount} success, ${syncFailureCount} failed`);

    // Retry pass: retry failed syncs from previous cycles
    const retryResults = await retryFailedSyncs();
    const retrySuccessCount = retryResults.filter(r => r.status === 'SYNCED').length;
    const retryFailureCount = retryResults.filter(r => r.status === 'FAILED').length;
    logger.info(`Retry pass complete: ${retrySuccessCount} recovered, ${retryFailureCount} still failing`);

    const duration = Date.now() - startTime;
    logger.info(`=== Inventory Sync Cycle Complete (${duration}ms) ===`);
  } catch (error: any) {
    logger.error('Sync cycle failed with error:', error);
  } finally {
    isRunning = false;
  }
}

/**
 * Manually trigger an inventory sync (for testing or API calls)
 * Returns immediately with results (does not wait for background cycle)
 */
export async function triggerInventorySyncNow() {
  logger.info('Manual sync triggered via API');
  return syncAllInventoryToMedusa();
}

/**
 * Get current scheduler status
 */
export function getSchedulerStatus() {
  return {
    running: isRunning,
    scheduled: intervalHandle !== null,
  };
}
