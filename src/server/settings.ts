/**
 * Settings writes for the admin: organisation, venues, rooms, terms and waiver
 * text with versions, and email templates. Owner only; every write is audited.
 */
import { z } from "zod";
import { and, asc, count, eq, gte, inArray } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";
import type { OpeningHours } from "@/db/schema";
import { timeToMinutes } from "@/core/time";
import { DEFAULT_TEMPLATES, type TemplateKey } from "@/providers/email/defaults";
import { audit } from "./audit";
import { AuthError, type CurrentUser } from "./auth";
import { AdminError, defined, parseInput, refreshVenueSessions, slugify, uniqueSlug, zf } from "./catalogue-admin";
import { isUuid } from "./catalogue";
import { getOrganisation } from "./org";

export function assertOwner(user: CurrentUser): void {
  if (!user.isOwner) throw new AuthError("FORBIDDEN", "Only the owner can change settings.");
}

/** The short list offered in Settings. The stored value is always kept selectable. */
export const TIMEZONES = [
  "Europe/London",
  "Europe/Dublin",
  "Europe/Lisbon",
  "Europe/Paris",
  "Europe/Amsterdam",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Rome",
  "America/New_York",
  "America/Toronto",
  "Australia/Sydney",
] as const;

// ---------- organisation ----------

/** Labels for the organisation fields, also used for the placeholder tags. */
export const ORG_FIELD_LABELS = {
  name: "Business name",
  tagline: "Tagline",
  legalName: "Legal name",
  legalAddress: "Registered address",
  companyNumber: "Company number",
  contactEmail: "Contact email",
  contactPhone: "Phone",
  whatsappUrl: "WhatsApp link",
  websiteUrl: "Website",
  brandPrimary: "Brand colour",
  brandInk: "Text colour",
  logoUrl: "Logo link",
  timezone: "Time zone",
  holdMinutes: "Hold while paying (minutes)",
  reminderHoursBefore: "Reminder (hours before)",
  retentionMonths: "Keep bookings for (months)",
} as const;

export const updateOrganisationSchema = z
  .object({
    name: zf.text("Business name", 120),
    tagline: zf.optText("Tagline", 200),
    legalName: zf.optText("Legal name", 200),
    legalAddress: zf.optText("Registered address", 500),
    companyNumber: zf.optText("Company number", 100),
    contactEmail: z.string().trim().email("Contact email: enter an email address."),
    contactPhone: zf.optText("Phone", 50),
    whatsappUrl: zf.optUrl("WhatsApp link"),
    websiteUrl: zf.optUrl("Website"),
    brandPrimary: zf.colour("Brand colour"),
    brandInk: zf.colour("Text colour"),
    logoUrl: zf.optUrl("Logo link"),
    timezone: z.string().refine(isValidTimezone, "Time zone: choose one from the list."),
    holdMinutes: zf.int("Hold while paying", 5, 60),
    reminderHoursBefore: zf.int("Reminder", 1, 168),
    retentionMonths: zf.int("Keep bookings for", 1, 120),
  })
  .partial();
export type UpdateOrganisationInput = z.input<typeof updateOrganisationSchema>;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Save organisation fields. A placeholder flag is cleared when its field is
 * saved with a new value, or listed in `confirm` ("this is correct").
 */
export async function updateOrganisation(
  db: DbOrTx,
  user: CurrentUser,
  input: UpdateOrganisationInput,
  opts: { confirm?: string[] } = {},
): Promise<s.Organisation> {
  assertOwner(user);
  const before = await getOrganisation(db);
  const patch = defined(parseInput(updateOrganisationSchema, input));
  const changed = Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== before[k as keyof s.Organisation]);
  const confirm = new Set([...(opts.confirm ?? []), ...changed]);
  const placeholdersPending = (before.placeholdersPending ?? []).filter((k) => !confirm.has(k));
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(s.organisations)
      .set({ ...patch, placeholdersPending, updatedAt: new Date() })
      .where(eq(s.organisations.id, before.id))
      .returning();
    await audit(tx, { user, action: "organisation.update", entityType: "organisation", entityId: row.id, before, after: row });
    return row;
  });
}

// ---------- terms and waiver ----------

export type LegalDoc = "terms" | "waiver";

/**
 * Save the terms or waiver wording. With `newVersion` the version goes up by one
 * (new bookings record the version they accepted); without, it is a wording fix.
 */
export async function saveLegalText(
  db: DbOrTx,
  user: CurrentUser,
  input: { doc: LegalDoc; text: string; newVersion: boolean },
): Promise<s.Organisation> {
  assertOwner(user);
  const doc = parseInput(z.enum(["terms", "waiver"]), input.doc);
  const text = parseInput(zf.text(doc === "terms" ? "Terms" : "Waiver", 50_000), input.text);
  const before = await getOrganisation(db);
  const textKey = doc === "terms" ? "termsText" : "waiverText";
  const versionKey = doc === "terms" ? "termsVersion" : "waiverVersion";
  const version = before[versionKey] + (input.newVersion ? 1 : 0);
  const textChanged = before[textKey] !== text;
  const placeholdersPending = textChanged ? before.placeholdersPending.filter((k) => k !== textKey) : before.placeholdersPending;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(s.organisations)
      .set({ [textKey]: text, [versionKey]: version, placeholdersPending, updatedAt: new Date() })
      .where(eq(s.organisations.id, before.id))
      .returning();
    await audit(tx, {
      user,
      action: input.newVersion ? `${doc}.new_version` : `${doc}.wording`,
      entityType: "organisation",
      entityId: row.id,
      before: { [textKey]: before[textKey], [versionKey]: before[versionKey] },
      after: { [textKey]: row[textKey], [versionKey]: row[versionKey] },
    });
    return row;
  });
}

/** Bump the terms (or waiver) version without changing the wording. */
export async function bumpTermsVersion(db: DbOrTx, user: CurrentUser, doc: LegalDoc = "terms"): Promise<number> {
  const org = await getOrganisation(db);
  const row = await saveLegalText(db, user, { doc, text: doc === "terms" ? org.termsText : org.waiverText, newVersion: true });
  return doc === "terms" ? row.termsVersion : row.waiverVersion;
}

// ---------- venues ----------

const hoursSchema = z
  .object({ open: zf.time("Opening time"), close: zf.time("Closing time") })
  .refine((h) => timeToMinutes(h.close) > timeToMinutes(h.open), "Opening hours: closing must be after opening.")
  .nullable();

export const openingHoursSchema = z.object({
  mon: hoursSchema,
  tue: hoursSchema,
  wed: hoursSchema,
  thu: hoursSchema,
  fri: hoursSchema,
  sat: hoursSchema,
  sun: hoursSchema,
});

export const updateVenueSchema = z
  .object({
    name: zf.text("Venue name", 120),
    status: z.enum(["open", "opening", "closed"], { error: "Status: choose one." }),
    opensAt: z.date().nullable(),
    address: zf.text("Address", 500),
    postcode: zf.optText("Postcode", 20),
    mapsUrl: zf.optUrl("Map link"),
    parkingNotes: zf.optText("Parking", 1000),
    transportNotes: zf.optText("Getting here", 1000),
    googleCalendarId: zf.optText("Google Calendar ID", 300),
    openingHours: openingHoursSchema,
    openingHoursConfirmed: z.boolean(),
    maxPlacesPerBooking: zf.int("Most places per booking", 1, 200),
    defaultLeadTimeMinutes: zf.int("Default notice", 0, 60 * 24 * 365),
    defaultCutoffMinutes: zf.int("Default cut-off", 0, 60 * 24 * 30),
    sortOrder: zf.int("Order", 0, 1000),
  })
  .partial()
  .refine((v) => v.status !== "opening" || v.opensAt !== null, "Opens on: an opening venue needs an opening date.");
export type UpdateVenueInput = z.input<typeof updateVenueSchema>;

async function loadVenue(db: DbOrTx, venueId: string): Promise<s.Venue> {
  const [v] = isUuid(venueId) ? await db.select().from(s.venues).where(eq(s.venues.id, venueId)).limit(1) : [];
  if (!v) throw new AdminError("That venue no longer exists.");
  return v;
}

/** Clear the organisation's "openingHours" placeholder once every venue's hours are confirmed. */
async function syncOpeningHoursFlag(db: DbOrTx): Promise<void> {
  const org = await getOrganisation(db);
  if (!org.placeholdersPending.includes("openingHours")) return;
  const venues = await db.select({ ok: s.venues.openingHoursConfirmed }).from(s.venues);
  if (venues.length && venues.every((v) => v.ok)) {
    await db
      .update(s.organisations)
      .set({ placeholdersPending: org.placeholdersPending.filter((k) => k !== "openingHours"), updatedAt: new Date() })
      .where(eq(s.organisations.id, org.id));
  }
}

/** Pending and confirmed bookings at a venue that have not started yet. */
async function countFutureBookings(db: DbOrTx, venueId: string, now: Date): Promise<number> {
  const [{ n }] = await db
    .select({ n: count() })
    .from(s.bookings)
    .where(and(eq(s.bookings.venueId, venueId), inArray(s.bookings.status, ["pending", "confirmed"]), gte(s.bookings.startsAt, now)));
  return Number(n);
}

/**
 * Save a venue. Status and opening date are checked together with what is already
 * saved (an opening venue needs an opening date). Closing a venue keeps its
 * bookings: `futureBookings` counts them and `message` (the flash text) says so.
 */
export async function updateVenue(
  db: DbOrTx,
  user: CurrentUser,
  venueId: string,
  input: UpdateVenueInput,
  opts: { now?: Date } = {},
): Promise<s.Venue & { futureBookings: number; message: string }> {
  assertOwner(user);
  const now = opts.now ?? new Date();
  const before = await loadVenue(db, venueId);
  const patch = defined(parseInput(updateVenueSchema, input));
  const status = patch.status ?? before.status;
  const opensAt = patch.opensAt !== undefined ? patch.opensAt : before.opensAt;
  if (status === "opening" && !opensAt) throw new AdminError("Opens on: an opening venue needs an opening date.");
  const after = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(s.venues)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(s.venues.id, venueId))
      .returning();
    await audit(tx, { user, action: "venue.update", entityType: "venue", entityId: row.id, venueId: row.id, before, after: row });
    return row;
  });
  await syncOpeningHoursFlag(db);
  if (patch.status !== undefined || patch.opensAt !== undefined) await refreshVenueSessions(db, venueId, now);
  const futureBookings = after.status === "closed" ? await countFutureBookings(db, venueId, now) : 0;
  const message = `${after.name} saved.${
    futureBookings
      ? ` It is closed to new bookings. ${futureBookings} ${futureBookings === 1 ? "booking is" : "bookings are"} still coming up and ${futureBookings === 1 ? "is" : "are"} kept: move or cancel ${futureBookings === 1 ? "it" : "them"}.`
      : ""
  }`;
  return { ...after, futureBookings, message };
}

export const DEFAULT_NEW_VENUE_HOURS: OpeningHours = {
  mon: { open: "10:00", close: "18:00" },
  tue: { open: "10:00", close: "18:00" },
  wed: { open: "10:00", close: "18:00" },
  thu: { open: "10:00", close: "18:00" },
  fri: { open: "10:00", close: "18:00" },
  sat: { open: "10:00", close: "18:00" },
  sun: { open: "10:00", close: "18:00" },
};

/** Create a venue (status "opening", hours unconfirmed) with one room, "Main room". */
export async function createVenue(db: DbOrTx, user: CurrentUser, input: { name: string }): Promise<{ venue: s.Venue; room: s.Room }> {
  assertOwner(user);
  const name = parseInput(zf.text("Venue name", 120), input.name);
  const org = await getOrganisation(db);
  return db.transaction(async (tx) => {
    const existing = await tx.select({ slug: s.venues.slug, sortOrder: s.venues.sortOrder }).from(s.venues);
    const slug = uniqueSlug(slugify(name), existing.map((v) => v.slug));
    const sortOrder = existing.reduce((m, v) => Math.max(m, v.sortOrder + 1), 0);
    const [venue] = await tx
      .insert(s.venues)
      .values({
        organisationId: org.id,
        slug,
        name,
        status: "closed",
        address: "",
        openingHours: DEFAULT_NEW_VENUE_HOURS,
        openingHoursConfirmed: false,
        sortOrder,
      })
      .returning();
    const [room] = await tx.insert(s.rooms).values({ venueId: venue.id, name: "Main room", sortOrder: 0 }).returning();
    await audit(tx, { user, action: "venue.create", entityType: "venue", entityId: venue.id, venueId: venue.id, after: { venue, room } });
    return { venue, room };
  });
}

// ---------- rooms ----------

export async function addRoom(db: DbOrTx, user: CurrentUser, venueId: string, input: { name: string }): Promise<s.Room> {
  assertOwner(user);
  await loadVenue(db, venueId);
  const name = parseInput(zf.text("Room name", 80), input.name);
  return db.transaction(async (tx) => {
    const existing = await tx.select({ sortOrder: s.rooms.sortOrder }).from(s.rooms).where(eq(s.rooms.venueId, venueId));
    const sortOrder = existing.reduce((m, r) => Math.max(m, r.sortOrder + 1), 0);
    const [room] = await tx.insert(s.rooms).values({ venueId, name, sortOrder }).returning();
    await audit(tx, { user, action: "room.create", entityType: "room", entityId: room.id, venueId, after: room });
    return room;
  });
}

async function loadRoom(db: DbOrTx, roomId: string): Promise<s.Room> {
  const [r] = isUuid(roomId) ? await db.select().from(s.rooms).where(eq(s.rooms.id, roomId)).limit(1) : [];
  if (!r) throw new AdminError("That room no longer exists.");
  return r;
}

export async function renameRoom(db: DbOrTx, user: CurrentUser, roomId: string, input: { name: string }): Promise<s.Room> {
  assertOwner(user);
  const before = await loadRoom(db, roomId);
  const name = parseInput(zf.text("Room name", 80), input.name);
  return db.transaction(async (tx) => {
    const [room] = await tx.update(s.rooms).set({ name }).where(eq(s.rooms.id, roomId)).returning();
    await audit(tx, { user, action: "room.rename", entityType: "room", entityId: room.id, venueId: room.venueId, before, after: room });
    return room;
  });
}

/** Rooms in use (by a service, session, booking, hold or block) cannot be deleted. */
export async function deleteRoom(db: DbOrTx, user: CurrentUser, roomId: string): Promise<void> {
  assertOwner(user);
  const room = await loadRoom(db, roomId);
  const [[svc], [ses], [bkg], [hld], [blk], [siblings]] = await Promise.all([
    db.select({ n: count() }).from(s.services).where(eq(s.services.roomId, roomId)),
    db.select({ n: count() }).from(s.sessions).where(eq(s.sessions.roomId, roomId)),
    db.select({ n: count() }).from(s.bookings).where(eq(s.bookings.roomId, roomId)),
    db.select({ n: count() }).from(s.holds).where(eq(s.holds.roomId, roomId)),
    db.select({ n: count() }).from(s.blocks).where(eq(s.blocks.roomId, roomId)),
    db.select({ n: count() }).from(s.rooms).where(eq(s.rooms.venueId, room.venueId)),
  ]);
  if (Number(svc.n) > 0) throw new AdminError("Services use this room. Move them to another room first.");
  if (Number(ses.n) + Number(bkg.n) + Number(hld.n) + Number(blk.n) > 0) {
    throw new AdminError("This room has sessions, bookings or blocked time, so it is kept. You can rename it instead.");
  }
  if (Number(siblings.n) <= 1) throw new AdminError("A venue needs at least one room.");
  await db.transaction(async (tx) => {
    await tx.delete(s.rooms).where(eq(s.rooms.id, roomId));
    await audit(tx, { user, action: "room.delete", entityType: "room", entityId: room.id, venueId: room.venueId, before: room });
  });
}

// ---------- email templates ----------

export const TEMPLATE_KEYS = DEFAULT_TEMPLATES.map((t) => t.key);

export function isTemplateKey(key: unknown): key is TemplateKey {
  return typeof key === "string" && (TEMPLATE_KEYS as string[]).includes(key);
}

export type TemplateRow = { key: TemplateKey; name: string; subject: string; body: string; isDefault: boolean };

/** The five templates in a fixed order, from the database or the defaults. */
export async function listEmailTemplates(db: DbOrTx, organisationId: string): Promise<TemplateRow[]> {
  const rows = await db.select().from(s.emailTemplates).where(eq(s.emailTemplates.organisationId, organisationId)).orderBy(asc(s.emailTemplates.key));
  return DEFAULT_TEMPLATES.map((def) => {
    const row = rows.find((r) => r.key === def.key);
    const subject = row?.subject ?? def.subject;
    const body = row && row.body.trim() !== "" ? row.body : def.body;
    return { key: def.key, name: row?.name ?? def.name, subject, body, isDefault: subject === def.subject && body === def.body };
  });
}

export const templateSchema = z.object({
  subject: zf.text("Subject", 300),
  body: zf.text("Message", 20_000),
});

export async function saveEmailTemplate(
  db: DbOrTx,
  user: CurrentUser,
  key: string,
  input: { subject: string; body: string },
): Promise<s.EmailTemplate> {
  assertOwner(user);
  if (!isTemplateKey(key)) throw new AdminError("That email template does not exist.");
  const data = parseInput(templateSchema, input);
  const org = await getOrganisation(db);
  const def = DEFAULT_TEMPLATES.find((t) => t.key === key);
  const [before] = await db
    .select()
    .from(s.emailTemplates)
    .where(and(eq(s.emailTemplates.organisationId, org.id), eq(s.emailTemplates.key, key)))
    .limit(1);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(s.emailTemplates)
      .values({ organisationId: org.id, key, name: before?.name ?? def?.name ?? key, subject: data.subject, body: data.body })
      .onConflictDoUpdate({
        target: [s.emailTemplates.organisationId, s.emailTemplates.key],
        set: { subject: data.subject, body: data.body, updatedAt: new Date() },
      })
      .returning();
    await audit(tx, {
      user,
      action: "email_template.update",
      entityType: "email_template",
      entityId: key,
      before: before ? { subject: before.subject, body: before.body } : null,
      after: { subject: row.subject, body: row.body },
    });
    return row;
  });
}

export async function resetEmailTemplate(db: DbOrTx, user: CurrentUser, key: string): Promise<s.EmailTemplate> {
  assertOwner(user);
  const def = DEFAULT_TEMPLATES.find((t) => t.key === key);
  if (!def) throw new AdminError("That email template does not exist.");
  return saveEmailTemplate(db, user, key, { subject: def.subject, body: def.body });
}
