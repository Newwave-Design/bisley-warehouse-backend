/**
 * WMS Notification helper — create site-wide notifications.
 * Never throws; logs errors to console only.
 */

import { query } from '../db/index.js';

type Severity = 'info' | 'warning' | 'error';

export async function createNotification(
  type: string,
  title: string,
  body?: string,
  options?: { link?: string; severity?: Severity; metadata?: Record<string, unknown> }
): Promise<void> {
  try {
    await query(
      `INSERT INTO wms_notifications (type, title, body, link, severity, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        type,
        title,
        body ?? null,
        options?.link ?? null,
        options?.severity ?? 'info',
        JSON.stringify(options?.metadata ?? {}),
      ]
    );
  } catch (err) {
    console.error('[notifications] Failed to create notification:', err);
  }
}

/** Deduplicate: skip if an unread notification of this type+title already exists within the last 24h */
export async function createNotificationOnce(
  type: string,
  title: string,
  body?: string,
  options?: { link?: string; severity?: Severity; metadata?: Record<string, unknown> }
): Promise<void> {
  try {
    const existing = await query(
      `SELECT id FROM wms_notifications
       WHERE type=$1 AND title=$2 AND is_read=false
         AND created_at > NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [type, title]
    );
    if (existing.rows.length > 0) return;
    await createNotification(type, title, body, options);
  } catch (err) {
    console.error('[notifications] Failed to create notification:', err);
  }
}
