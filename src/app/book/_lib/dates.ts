/** Date helpers for the booking page. Dates are 'YYYY-MM-DD' in the venue's timezone. */
import { addDays, fmtLocal, localDate } from "@/core/time";

export { addDays };

export function todayIn(tz: string, now = new Date()): string {
  return localDate(now, tz);
}

/** 'YYYY-MM' of a date string. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function firstOfMonth(month: string): string {
  return `${month}-01`;
}

export function lastOfMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** 0 = Monday … 6 = Sunday (UK calendars start on Monday). */
export function weekdayMon0(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function noonUtc(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

/** "October 2026" */
export function formatMonth(month: string): string {
  return fmtLocal(noonUtc(firstOfMonth(month)), "MMMM yyyy", "UTC");
}

/** "Saturday 24 October" */
export function formatDay(date: string): string {
  return fmtLocal(noonUtc(date), "EEEE d MMMM", "UTC");
}

/** "Saturday 24 October 2026" */
export function formatDayWithYear(date: string): string {
  return fmtLocal(noonUtc(date), "EEEE d MMMM yyyy", "UTC");
}

/** "14:00" */
export function formatTime(iso: string, tz: string): string {
  return fmtLocal(new Date(iso), "HH:mm", tz);
}

/** "Saturday 24 October 2026, 14:00 to 15:30" */
export function formatWhen(startsAt: string, endsAt: string, tz: string): string {
  const start = new Date(startsAt);
  return `${fmtLocal(start, "EEEE d MMMM yyyy", tz)}, ${formatTime(startsAt, tz)} to ${formatTime(endsAt, tz)}`;
}

/** "17 October" */
export function formatOpens(iso: string, tz: string): string {
  return fmtLocal(new Date(iso), "d MMMM", tz);
}

/** "1 hour", "2 hours", "90 minutes" */
export function formatLength(minutes: number): string {
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  return `${minutes} minutes`;
}

/** "14:59" style countdown from milliseconds. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 'YYYY-MM-DD' of an ISO instant in the zone. */
export function localDateOf(iso: string, tz: string): string {
  return localDate(new Date(iso), tz);
}
