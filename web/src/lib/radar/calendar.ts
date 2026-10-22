/**
 * Calendar arithmetic for the Radar temporal estimator.
 *
 * All dates are ISO 8601 string (YYYY-MM-DD). No timezone handling —
 * contract dates are date-only, no time component.
 */

// ─── Helpers ─────────────────────────────────────────────────────────

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse an ISO date string into a YearMonthDay object.
 * Rejects if string is not valid ISO (YYYY-MM-DD).
 */
export function parseDate(s: string): { year: number; month: number; day: number } {
  if (!ISO_RE.test(s)) throw new Error(`Invalid ISO date: ${s}`);
  const [yearStr, monthStr, dayStr] = s.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error(`Invalid ISO date: ${s}`);
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Invalid ISO date: ${s}`);
  }
  // Verify the date is real (rejects Feb 30, etc.)
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    throw new Error(`Invalid ISO date: ${s}`);
  }
  return { year, month, day };
}

/** Format a YearMonthDay back to ISO string. */
export function formatDate(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Check if a year is a leap year (Gregorian). */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

/** Days in a given month/year. */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

// ─── Public arithmetic ───────────────────────────────────────────────

/**
 * Add months to a date, clamping to last day of month if necessary.
 *
 * Examples:
 *   2024-01-31 + 1 month → 2024-02-29 (leap year, clamped)
 *   2024-03-31 + 1 month → 2024-04-30 (clamped)
 *   2024-01-31 - 1 month → 2023-12-31
 */
export function addMonths(dateStr: string, months: number): string {
  const { year, month, day } = parseDate(dateStr);
  if (!Number.isInteger(months) || months === 0) {
    return dateStr;
  }
  const sign = months < 0 ? -1 : 1;
  const absMonths = Math.abs(months);
  let y = year;
  let m = month;
  let d = day;

  // Move years first
  y += Math.floor(absMonths / 12) * sign;
  m += (absMonths % 12) * sign;

  // Normalize month overflow
  while (m > 12) { m -= 12; y += 1; }
  while (m < 1) { m += 12; y -= 1; }

  // Clamp to last day of target month
  const maxDay = daysInMonth(y, m);
  d = Math.min(d, maxDay);

  return formatDate(y, m, d);
}

/**
 * Add years to a date, clamping to Feb 28/29 as appropriate.
 *
 * Examples:
 *   2024-02-29 + 1 year → 2025-02-28 (non-leap year, clamped)
 *   2024-02-29 + 4 years → 2028-02-29 (leap year, preserved)
 */
export function addYears(dateStr: string, years: number): string {
  const { year, month, day } = parseDate(dateStr);
  if (!Number.isInteger(years) || years === 0) {
    return dateStr;
  }
  const newYear = year + years;
  const maxDay = daysInMonth(newYear, month);
  const newDay = Math.min(day, maxDay);
  return formatDate(newYear, month, newDay);
}

/**
 * Add days to a date.
 *
 * Examples:
 *   2024-01-15 + 30 days → 2024-02-14
 *   2024-01-15 - 1 day → 2024-01-14
 */
export function addDays(dateStr: string, days: number): string {
  const { year, month, day } = parseDate(dateStr);
  if (!Number.isInteger(days) || days === 0) {
    return dateStr;
  }
  const d = new Date(year, month - 1, day);
  d.setDate(d.getDate() + days);
  return formatDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}