/**
 * Time helpers. All business rules are evaluated in the organisation timezone
 * (Europe/London by default); storage is UTC `Date`s.
 */
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";

export const DEFAULT_TZ = "Europe/London";

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday
export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

/** Half-open interval overlap: a 16:00 end does not overlap a 16:00 start. */
export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime();
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60_000;
}

/** 'YYYY-MM-DD' of the instant in the zone. */
export function localDate(d: Date, tz = DEFAULT_TZ): string {
  return formatInTimeZone(d, tz, "yyyy-MM-dd");
}

/** 'HH:mm' of the instant in the zone. */
export function localTime(d: Date, tz = DEFAULT_TZ): string {
  return formatInTimeZone(d, tz, "HH:mm");
}

/** 0 = Sunday … 6 = Saturday, in the zone. */
export function localWeekday(d: Date, tz = DEFAULT_TZ): Weekday {
  return Number(formatInTimeZone(d, tz, "i")) % 7 as Weekday; // ISO day 7 (Sun) -> 0
}

export function weekdayKey(d: Date, tz = DEFAULT_TZ): WeekdayKey {
  return WEEKDAY_KEYS[localWeekday(d, tz)];
}

/**
 * Build the UTC instant for a local date + 'HH:mm' in the zone.
 * Across the BST->GMT change (late October) 01:30 is ambiguous; date-fns-tz
 * picks the first occurrence, which is fine for 10:00–20:00 business hours.
 */
export function zonedDateTime(dateStr: string, time: string, tz = DEFAULT_TZ): Date {
  const [h, m] = time.split(":").map(Number);
  const hh = String(h).padStart(2, "0");
  const mm = String(m ?? 0).padStart(2, "0");
  return fromZonedTime(`${dateStr}T${hh}:${mm}:00`, tz);
}

/** Start of the local day (00:00 in the zone) as a UTC instant. */
export function startOfLocalDay(dateStr: string, tz = DEFAULT_TZ): Date {
  return zonedDateTime(dateStr, "00:00", tz);
}

/** Start of the next local day. */
export function endOfLocalDay(dateStr: string, tz = DEFAULT_TZ): Date {
  return startOfLocalDay(addDays(dateStr, 1), tz);
}

/** Add whole days to a 'YYYY-MM-DD' string (calendar arithmetic, no DST issues). */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Inclusive list of 'YYYY-MM-DD' from -> to. */
export function eachLocalDay(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  let guard = 0;
  while (cur <= to && guard++ < 400) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

export function isValidDateStr(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidTimeStr(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** 'HH:mm' -> minutes since midnight. */
export function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m ?? 0);
}

export function minutesToTime(mins: number): string {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Friendly formatting for UI and emails, in the zone. */
export function fmtLocal(d: Date, pattern: string, tz = DEFAULT_TZ): string {
  return formatInTimeZone(d, tz, pattern);
}

export function fmtDayLong(d: Date, tz = DEFAULT_TZ): string {
  return formatInTimeZone(d, tz, "EEEE d MMMM yyyy");
}

export function fmtTime(d: Date, tz = DEFAULT_TZ): string {
  return formatInTimeZone(d, tz, "HH:mm");
}

export function fmtDayShort(d: Date, tz = DEFAULT_TZ): string {
  return formatInTimeZone(d, tz, "EEE d MMM");
}

/** For completeness: a Date whose wall-clock fields read as the zone's local time. */
export function toLocal(d: Date, tz = DEFAULT_TZ): Date {
  return toZonedTime(d, tz);
}

/** Money: integer pence -> "£17.00" (or "£17" when whole and `short`). */
export function fmtPence(pence: number, short = false): string {
  const sign = pence < 0 ? "-" : "";
  const abs = Math.abs(pence);
  const pounds = Math.floor(abs / 100);
  const pennies = abs % 100;
  if (short && pennies === 0) return `${sign}£${pounds}`;
  return `${sign}£${pounds}.${String(pennies).padStart(2, "0")}`;
}
