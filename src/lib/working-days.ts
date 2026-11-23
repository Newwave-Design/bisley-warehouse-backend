/**
 * Days couriers collect and deliver: weekdays that are not England and Wales bank holidays.
 * Source: gov.uk/bank-holidays. Add the next year before the last one listed runs out.
 * The dashboard keeps the same list in src/utils/workingDays.ts.
 */
export const UK_BANK_HOLIDAYS = new Set([
  '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28',
  '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28',
  '2028-01-03', '2028-04-14', '2028-04-17', '2028-05-01', '2028-05-29', '2028-08-28', '2028-12-25', '2028-12-26',
]);

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isBankHoliday(year: number, month: number, day: number): boolean {
  return UK_BANK_HOLIDAYS.has(iso(year, month, day));
}

/** A weekday ('Mon'..'Sun', en-GB short) that is not a bank holiday. */
export function isWorkingDay(parts: { year: number; month: number; day: number; weekday: string }): boolean {
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  return !isBankHoliday(parts.year, parts.month, parts.day);
}

/** Same check for a YYYY-MM-DD date. */
export function isWorkingIsoDay(value: string): boolean {
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !UK_BANK_HOLIDAYS.has(value.slice(0, 10));
}
