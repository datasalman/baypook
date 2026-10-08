import type * as s from "@/db/schema";
import type { AdminContext } from "@/server/venue-scope";

/**
 * The venue a catalogue page works on: `?venue=` (slug or id) when the user can
 * see it, else the selected venue, else the first visible one.
 */
export function pickVenue(ctx: AdminContext, param: string | string[] | undefined): s.Venue | null {
  const v = Array.isArray(param) ? param[0] : param;
  const fromParam = v ? ctx.venues.find((x) => x.slug === v || x.id === v) : undefined;
  return fromParam ?? ctx.selectedVenues[0] ?? ctx.venues[0] ?? null;
}

/** Venue tabs for an "All venues" selection: one link per selected venue. */
export function venueTabs(ctx: AdminContext, path: string, extra: Record<string, string> = {}): { value: string; label: string; href: string }[] {
  if (ctx.selectedVenues.length < 2) return [];
  return ctx.selectedVenues.map((v) => ({
    value: v.id,
    label: v.name,
    href: `${path}?${new URLSearchParams({ ...extra, venue: v.slug }).toString()}`,
  }));
}

export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** "48 hours", "90 minutes", "No notice". */
export function fmtMinutes(mins: number, zero = "None"): string {
  if (mins <= 0) return zero;
  if (mins % 60 === 0) {
    const h = mins / 60;
    return `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  if (mins > 60) return `${Math.floor(mins / 60)} h ${mins % 60} min`;
  return `${mins} min`;
}

/** Minutes to an hours field value: 2880 -> "48", 90 -> "1.5". */
export function minutesToHoursField(mins: number): string {
  const h = mins / 60;
  return Number.isInteger(h) ? String(h) : String(Math.round(h * 100) / 100);
}
