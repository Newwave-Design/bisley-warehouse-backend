/**
 * Settlement weeks: Monday to Sunday, in UK time. A week is identified by its Monday as YYYY-MM-DD.
 */

const DAY = 86400000;

export const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

/** UK calendar date (YYYY-MM-DD) of an instant. */
export function ukDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}

export function utcDay(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

export function isoOf(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** Monday of the week containing the given date (YYYY-MM-DD). */
export function mondayOf(iso: string): string {
  const t = utcDay(iso);
  const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  return isoOf(t - dow * DAY);
}

export function sundayOf(weekStart: string): string {
  return isoOf(utcDay(weekStart) + 6 * DAY);
}

export function isMonday(iso: string): boolean {
  return WEEK_RE.test(iso) && !Number.isNaN(utcDay(iso)) && new Date(utcDay(iso)).getUTCDay() === 1;
}

export function fmtDay(iso: string): string {
  return new Date(utcDay(iso)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function weekLabel(weekStart: string): string {
  const end = sundayOf(weekStart);
  return `${fmtDay(weekStart)} – ${fmtDay(end)} ${end.slice(0, 4)}`;
}

export function currentWeekStart(now = new Date()): string {
  return mondayOf(ukDate(now));
}
