/** Shared serialisers and lookups for the `/api/v1` routes. Not a route itself. */
import type { DbOrTx } from "@/db";
import type * as s from "@/db/schema";
import { isDemo, env } from "@/lib/env";
import { ApiError } from "@/lib/api";
import { getVenueBySlug } from "@/server/org";
import { getServiceForVenue, type ServiceWithCatalogue } from "@/server/catalogue";

/** Closed venues and (live mode) venues without a Stripe key cannot be booked online. */
export function onlineBookable(venue: Pick<s.Venue, "slug" | "status">): boolean {
  if (venue.status === "closed") return false;
  return isDemo() || Boolean(env.stripeSecretKey(venue.slug));
}

export function venueJson(venue: s.Venue, timezone: string) {
  return {
    slug: venue.slug,
    name: venue.name,
    status: venue.status,
    opensAt: venue.opensAt ? venue.opensAt.toISOString() : null,
    address: venue.address,
    postcode: venue.postcode ?? "",
    mapsUrl: venue.mapsUrl,
    parkingNotes: venue.parkingNotes,
    transportNotes: venue.transportNotes,
    maxPlacesPerBooking: venue.maxPlacesPerBooking,
    onlineBookable: onlineBookable(venue),
    timezone,
  };
}

/**
 * The organisation as the public booking page needs it: legal links and versions, the condensed
 * waiver wording, contact details and the timezone. Nothing private (no legal address, no settings).
 */
export function organisationJson(org: s.Organisation) {
  return {
    name: org.name,
    termsUrl: org.termsUrl?.trim() || null,
    privacyUrl: org.privacyUrl?.trim() || null,
    termsVersion: org.termsVersion,
    waiverVersion: org.waiverVersion,
    waiverText: org.waiverText,
    contactEmail: org.contactEmail,
    contactPhone: org.contactPhone?.trim() || null,
    whatsappUrl: org.whatsappUrl?.trim() || null,
    timezone: org.timezone,
  };
}

function noteJson(x: { inStoreNoteLine: string | null; inStoreNoteShort: string | null; inStoreMenuUrl: string | null }) {
  const line = x.inStoreNoteLine?.trim() || x.inStoreNoteShort?.trim() || "";
  const short = x.inStoreNoteShort?.trim() || x.inStoreNoteLine?.trim() || "";
  if (!line && !short) return null;
  return { line, short, menuUrl: x.inStoreMenuUrl?.trim() || null };
}

export function serviceJson(svc: ServiceWithCatalogue) {
  return {
    id: svc.id,
    slug: svc.slug,
    kind: svc.kind,
    name: svc.name,
    blurb: svc.blurb,
    lengthMinutes: svc.lengthMinutes,
    slotIntervalMinutes: svc.kind === "slot" ? svc.slotIntervalMinutes : null,
    colour: svc.colour,
    leadTimeMinutes: svc.leadTimeMinutes,
    cutoffMinutes: svc.cutoffMinutes,
    payInStoreEnabled: svc.payInStoreEnabled,
    inStoreNote: noteJson(svc),
    options: svc.options.map((o) => ({
      id: o.id,
      name: o.name,
      blurb: o.blurb,
      unitPricePence: o.unitPricePence,
      includedChildren: o.includedChildren,
      maxPerBooking: o.maxPerBooking,
      inStoreNote: noteJson(o),
    })),
    addOns: svc.addOns.map((a) => ({
      id: a.id,
      name: a.name,
      blurb: a.blurb,
      pricePence: a.pricePence,
      kind: a.kind,
      extraMinutes: a.extraMinutes,
      maxQuantity: a.maxQuantity,
      perChild: a.perChild,
    })),
  };
}

export async function requireVenue(db: DbOrTx, slug: string): Promise<s.Venue> {
  const venue = await getVenueBySlug(db, slug);
  if (!venue) throw new ApiError("NOT_FOUND", "We could not find that venue.");
  return venue;
}

/** A non-archived, online-enabled service at the venue, by id or slug. */
export async function requireOnlineService(db: DbOrTx, venue: s.Venue, idOrSlug: string): Promise<ServiceWithCatalogue> {
  const svc = await getServiceForVenue(db, venue.id, idOrSlug);
  if (!svc || !svc.onlineEnabled || svc.archivedAt) throw new ApiError("NOT_FOUND", "We could not find that service.");
  return svc;
}
