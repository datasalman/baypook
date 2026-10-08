import { addDays, isValidDateStr, localDate } from "@/core/time";

/** A valid 'YYYY-MM-DD' from a search param, or the fallback. */
export function dateParam(value: string | string[] | undefined, fallback: string): string {
  const v = Array.isArray(value) ? value[0] : value;
  return v && isValidDateStr(v) ? v : fallback;
}

/** Today's local date in the organisation timezone. */
export function todayIn(tz: string): string {
  return localDate(new Date(), tz);
}

/** "Today", "Tomorrow", "Yesterday" or null. */
export function relativeDayName(date: string, today: string): string | null {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  if (date === addDays(today, -1)) return "Yesterday";
  return null;
}

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
