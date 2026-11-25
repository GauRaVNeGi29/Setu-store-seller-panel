/**
 * Time ranges in days: a vendor's processing time (to make or ready an order)
 * and the store's delivery time (to reach the buyer after that). Safe to use
 * in the browser.
 */

export const DAYS_MAX = 365;

export type DayRange = { min: number; max: number };

const WHOLE = /^\d{1,3}$/;

/**
 * Reads the two numbers of a range from a form. Both empty means "not set".
 * `what` names the range in messages, e.g. "processing time".
 */
export function cleanDayRange(minRaw: string, maxRaw: string, what: string): { range: DayRange | null; error?: string } {
  const a = minRaw.trim();
  const b = maxRaw.trim();
  if (!a && !b) return { range: null };
  if (!a || !b) return { range: null, error: `Enter both numbers for the ${what}, e.g. 10 and 15.` };
  if (!WHOLE.test(a) || !WHOLE.test(b)) return { range: null, error: "Enter whole numbers of days, e.g. 10 and 15." };
  const min = Number(a);
  const max = Number(b);
  if (max < min) return { range: null, error: "The second number can't be smaller than the first." };
  if (max > DAYS_MAX) return { range: null, error: `Keep it to ${DAYS_MAX} days or fewer.` };
  if (max === 0) return { range: null, error: "Enter at least 1 day." };
  return { range: { min, max } };
}

/** A range from two stored columns; null unless both are set. */
export const rangeOf = (min: number | null | undefined, max: number | null | undefined): DayRange | null =>
  min == null || max == null ? null : { min, max };

/** "10–15 days", "7 days", "1 day". */
export function daysText(r: DayRange): string {
  if (r.min === r.max) return `${r.max} ${r.max === 1 ? "day" : "days"}`;
  return `${r.min}–${r.max} days`;
}

/** Processing plus delivery: what the buyer waits in total. Null unless both are known. */
export const totalDays = (processing: DayRange | null, delivery: DayRange | null): DayRange | null =>
  processing && delivery ? { min: processing.min + delivery.min, max: processing.max + delivery.max } : null;
