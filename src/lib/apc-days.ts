/** Weekdays APC can be asked to collect, starting with today when today is a weekday. */

export function weekdayCollectionDates(count: number, now = new Date()): string[] {
  const dates: string[] = []
  for (let days = 0; dates.length < count && days < 21; days += 1) {
    const shifted = shiftLondonDate(days, now)
    if (shifted.weekday === 'Sat' || shifted.weekday === 'Sun') continue
    dates.push(apcDate(shifted.year, shifted.month, shifted.day))
  }
  return dates
}

/** Weekdays after a dd/mm/yyyy collection date. */
export function weekdaysAfter(date: string, count: number): string[] {
  const match = date.match(/^(\d{2})\/(\d{2})\/(\d{4})/)
  if (!match) return weekdayCollectionDates(count).filter((item) => item !== date)
  const start = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]), 12))
  return weekdayCollectionDates(count + 1, start).filter((item) => item !== date).slice(0, count)
}

/** APC refused the day, rather than the address or the box. */
export function collectionDateRefused(detail: string): boolean {
  const text = detail.toLowerCase()
  if (!text) return false
  return /can.?t collect today|cannot collect today|cannot collect on|unable to collect|cut-?off|cutoff|too late|latest booking|collection date|not available for collection|has passed/.test(text)
}

function londonParts(now: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const read = (type: string) => parts.find((part) => part.type === type)?.value || ''
  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
    weekday: read('weekday'),
  }
}

function shiftLondonDate(days: number, now: Date) {
  const parts = londonParts(now)
  return londonParts(new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12)))
}

function apcDate(year: number, month: number, day: number): string {
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`
}
