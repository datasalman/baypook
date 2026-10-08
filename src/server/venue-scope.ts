/**
 * Venue scoping for the admin. The selected venue lives in the `bp_venue`
 * cookie (a venue id, or `all` for the owner). Every admin page should start
 * with `const ctx = await getAdminContext()` and only query `ctx.selectedVenues`
 * (or check `canAccessVenue(ctx.user, id)` for a record it loads by id).
 *
 * The server action that changes the selection is `selectVenue` in
 * `src/app/(admin)/admin/_lib/actions.ts` ("use server" files may only export
 * async functions, so it cannot live here).
 */
import type { Db } from "@/db";
import type * as s from "@/db/schema";
import { env, isDemo } from "@/lib/env";
import { emailConfigured } from "@/providers";
import { getOrganisation, listVenues } from "./org";
import { requireUser, visibleVenueIds, type CurrentUser } from "./auth";

export const VENUE_COOKIE = "bp_venue";
export const ALL_VENUES = "all";

export type SelectedVenueId = string | typeof ALL_VENUES;

export type AdminContext = {
  db: Db;
  user: CurrentUser;
  org: s.Organisation;
  /** Venues this user may see, in the admin's order. */
  venues: s.Venue[];
  selectedVenueId: SelectedVenueId;
  /** The venues the current view should show (one, or all visible for "all"). */
  selectedVenues: s.Venue[];
  /** Amber warnings for half-configured live systems. Empty in demo mode. */
  fallbackBanners: string[];
  /** True when the venue switcher should be shown (more than one visible venue). */
  canSwitchVenue: boolean;
};

/** Pure: resolve the selection from the cookie value and the visible venues. */
export function resolveSelectedVenue(
  user: Pick<CurrentUser, "isOwner">,
  visible: Pick<s.Venue, "id">[],
  cookieValue: string | undefined | null,
): SelectedVenueId {
  if (cookieValue === ALL_VENUES && user.isOwner && visible.length > 1) return ALL_VENUES;
  if (cookieValue && visible.some((v) => v.id === cookieValue)) return cookieValue;
  if (user.isOwner && visible.length > 1) return ALL_VENUES;
  return visible[0]?.id ?? ALL_VENUES;
}

/** Live-mode warnings for providers that fell back to the demo adapter or are missing. */
export function fallbackBannersFor(venues: Pick<s.Venue, "slug" | "name" | "status">[]): string[] {
  if (isDemo()) return [];
  const out: string[] = [];
  const email = emailConfigured();
  if (!email.ok) out.push("Email is not connected: messages are written to the Outbox but not sent. See Connections.");
  if (!env.googleServiceAccountJson()) {
    out.push("Google Calendar is not connected: bookings are written to the Calendar log but not pushed. See Connections.");
  }
  const noStripe = venues.filter((v) => v.status !== "closed" && !env.stripeSecretKey(v.slug)).map((v) => v.name);
  if (noStripe.length) {
    out.push(`Online payments are not connected for ${noStripe.join(" and ")}: it cannot be booked online. See Connections.`);
  }
  if (!env.cronSecret()) {
    out.push("Scheduled jobs are not set up (CRON_SECRET is missing): reminders and hold clean-up will not run on their own. See Connections.");
  }
  return out;
}

async function loadAdminContext(): Promise<AdminContext> {
  const user = await requireUser();
  const { getDb } = await import("@/db");
  const db = await getDb();
  const [org, all] = await Promise.all([getOrganisation(db), listVenues(db)]);
  const ids = new Set(visibleVenueIds(user, all.map((v) => v.id)));
  const venues = all.filter((v) => ids.has(v.id));

  const { cookies } = await import("next/headers");
  const jar = await cookies();
  const selectedVenueId = resolveSelectedVenue(user, venues, jar.get(VENUE_COOKIE)?.value);
  const selectedVenues = selectedVenueId === ALL_VENUES ? venues : venues.filter((v) => v.id === selectedVenueId);

  return {
    db,
    user,
    org,
    venues,
    selectedVenueId,
    selectedVenues,
    fallbackBanners: fallbackBannersFor(venues),
    canSwitchVenue: venues.length > 1,
  };
}

let cached: (() => Promise<AdminContext>) | null = null;

/**
 * Everything an admin page needs: the signed-in user (or a redirect to /login),
 * the organisation, visible venues and the current selection. Deduplicated per request.
 */
export async function getAdminContext(): Promise<AdminContext> {
  if (!cached) {
    const { cache } = await import("react");
    cached = cache(loadAdminContext);
  }
  return cached();
}

/**
 * Set the venue cookie after checking access. Use from a server action or
 * route handler. Returns the stored value, or null when not allowed.
 */
export async function setSelectedVenueCookie(user: CurrentUser, venueId: string, allVenueIds: string[]): Promise<SelectedVenueId | null> {
  const visible = visibleVenueIds(user, allVenueIds);
  let value: SelectedVenueId | null = null;
  if (venueId === ALL_VENUES) value = user.isOwner ? ALL_VENUES : null;
  else if (visible.includes(venueId)) value = venueId;
  if (!value) return null;
  const { cookies } = await import("next/headers");
  const jar = await cookies();
  jar.set(VENUE_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.baseUrl().startsWith("https://"),
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return value;
}
