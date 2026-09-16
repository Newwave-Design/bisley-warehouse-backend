// Centralised WMS error logging utility — used by all routes
import { query } from '../db/index.js';

export type ErrorSource =
  | 'GENERO_SUBMIT' | 'GENERO_POLL'
  | 'MEDUSA_SYNC' | 'WEBHOOK'
  | 'MOBILE' | 'INVENTORY_SYNC'
  | 'REORDER_CHECK' | 'DISCREPANCY_CHECK' | 'SYSTEM';

export type ErrorSeverity = 'ERROR' | 'WARNING' | 'INFO';

export async function logError(
  source: ErrorSource,
  message: string,
  context?: Record<string, any>,
  severity: ErrorSeverity = 'ERROR',
  stack?: string
): Promise<void> {
  try {
    await query(
      `INSERT INTO wms_error_log (source, severity, message, context, stack)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [source, severity, message, context ? JSON.stringify(context) : null, stack ?? null]
    );
  } catch (e) {
    // Never let logging itself crash the caller
    console.error('[logError] Failed to write to wms_error_log:', e);
  }
}

export async function logWarning(source: ErrorSource, message: string, context?: Record<string, any>): Promise<void> {
  return logError(source, message, context, 'WARNING');
}

export async function logInfo(source: ErrorSource, message: string, context?: Record<string, any>): Promise<void> {
  return logError(source, message, context, 'INFO');
}

/**
 * Simple console logger for module-level logging
 * Used throughout warehouse-backend for real-time visibility
 * All calls are also written to wms_error_log via logInfo/logError
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export function getLogger(module: string): Logger {
  const prefix = `[${module}]`;
  return {
    info: (msg: string) => console.log(`${prefix} ℹ️  ${msg}`),
    warn: (msg: string) => console.warn(`${prefix} ⚠️  ${msg}`),
    error: (msg: string) => console.error(`${prefix} ❌ ${msg}`),
    debug: (msg: string) => process.env.DEBUG && console.debug(`${prefix} 🔍 ${msg}`),
  };
}
