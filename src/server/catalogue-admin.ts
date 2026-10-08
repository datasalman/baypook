/**
 * Catalogue writes for the admin: services, options, add-ons, timetable rules,
 * timetable exceptions, blocks and single session occurrences.
 *
 * Every write checks `canManageCatalogue` (owner or a manager of the venue),
 * validates with zod, writes, and records an audit row with before/after.
 * Timetable and capacity changes re-run `ensureSessions` for the next 62 days so
 * the Today and Week views (and the next availability call) see them at once.
 */
import { z } from "zod";
import { and, asc, eq, gt, gte, inArray, isNull, lt, max, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";
import { addDays, isValidDateStr, localDate, timeToMinutes, minutesToTime, WEEKDAY_KEYS, zonedDateTime, endOfLocalDay, startOfLocalDay } from "@/core/time";
import { audit } from "./audit";
import { AuthError, canAccessVenue, canManageCatalogue, type CurrentUser } from "./auth";
import { isUuid } from "./catalogue";
import { getOrganisation } from "./org";
import { ensureSessions, ensureVenueSessions } from "./sessions";

// ---------- errors and validation ----------

/** A friendly, user-facing problem with the input or the request. */
export class AdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminError";
  }
}

/** Plain-words message for any error thrown by an admin write. */
export function adminErrorMessage(e: unknown): string {
  if (e instanceof AdminError || e instanceof AuthError) return e.message;
  console.error("[admin] unexpected error", e);
  return "Something went wrong. Please try again.";
}

/** Validate with zod and throw the first issue as an AdminError. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new AdminError(r.error.issues[0]?.message ?? "Please check the form.");
  return r.data;
}

/** Drop undefined keys (so a partial patch only touches what was sent). */
export function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

export const zf = {
  text: (label: string, maxLen = 200) =>
    z
      .string({ error: `${label} is needed.` })
      .trim()
      .min(1, `${label} is needed.`)
      .max(maxLen, `${label} is too long (${maxLen} characters at most).`),
  /** Optional text: "" becomes null; undefined stays undefined (not sent). */
  optText: (label: string, maxLen = 2000) =>
    z
      .string()
      .trim()
      .max(maxLen, `${label} is too long (${maxLen} characters at most).`)
      .nullish()
      .transform((v) => (v === undefined ? undefined : v === null || v === "" ? null : v)),
  optUrl: (label: string) =>
    z
      .string()
      .trim()
      .max(500, `${label} is too long.`)
      .nullish()
      .transform((v) => (v === undefined ? undefined : v === null || v === "" ? null : v))
      .refine((v) => v === undefined || v === null || /^https?:\/\/\S+$/i.test(v), `${label} must start with https://`),
  int: (label: string, min: number, maxN: number) =>
    z
      .number({ error: `${label}: enter a number.` })
      .int(`${label}: use a whole number.`)
      .min(min, `${label}: ${min} at least.`)
      .max(maxN, `${label}: ${maxN} at most.`),
  colour: (label = "Colour") => z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, `${label}: pick a colour.`),
  time: (label = "Time") => z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, `${label}: use HH:MM, for example 14:00.`),
  date: (label = "Date") => z.string().trim().refine(isValidDateStr, `${label}: pick a date.`),
  uuid: (label: string) => z.string().refine(isUuid, `${label}: choose one from the list.`),
};

/** "17", "17.5", "£17.50" -> 1750 pence. NaN when it is not a price. */
export function poundsToPence(input: string | null | undefined): number {
  const v = (input ?? "").replace(/[£,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return Number.NaN;
  const [whole, frac = ""] = v.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** 1750 -> "17.50" for a price input. */
export function penceToPounds(pence: number): string {
  return `${Math.floor(pence / 100)}.${String(pence % 100).padStart(2, "0")}`;
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "item";
}

/** First free slug: `name`, `name-2`, `name-3`… */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!set.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

// ---------- permissions and loading ----------

const FORBIDDEN_MESSAGE = "Only the owner or a manager of this venue can change the catalogue.";

export function assertCanManage(user: CurrentUser, venueId: string): void {
  if (!canManageCatalogue(user, venueId)) throw new AuthError("FORBIDDEN", FORBIDDEN_MESSAGE);
}

async function loadService(db: DbOrTx, user: CurrentUser, serviceId: string): Promise<s.Service> {
  if (!isUuid(serviceId)) throw new AdminError("That service no longer exists.");
  const [row] = await db.select().from(s.services).where(eq(s.services.id, serviceId)).limit(1);
  if (!row || !canAccessVenue(user, row.venueId)) throw new AdminError("That service no longer exists.");
  assertCanManage(user, row.venueId);
  return row;
}

async function loadVenue(db: DbOrTx, venueId: string): Promise<s.Venue> {
  const [v] = isUuid(venueId) ? await db.select().from(s.venues).where(eq(s.venues.id, venueId)).limit(1) : [];
  if (!v) throw new AdminError("That venue no longer exists.");
  return v;
}

async function assertRoomInVenue(db: DbOrTx, roomId: string, venueId: string): Promise<void> {
  const [room] = await db.select().from(s.rooms).where(eq(s.rooms.id, roomId)).limit(1);
  if (!room || room.venueId !== venueId) throw new AdminError("Room: choose a room at this venue.");
}

async function orgTz(db: DbOrTx): Promise<string> {
  const org = await getOrganisation(db);
  return org.timezone || "Europe/London";
}

/** Days ahead that `refreshServiceSessions` materialises. */
export const SESSION_WINDOW_DAYS = 62;

/** Re-run session generation for one service over the next 62 days. */
export async function refreshServiceSessions(db: DbOrTx, serviceId: string): Promise<void> {
  const [svc] = await db.select().from(s.services).where(eq(s.services.id, serviceId)).limit(1);
  if (!svc || svc.kind !== "session" || svc.archivedAt) return;
  const venue = await loadVenue(db, svc.venueId);
  const tz = await orgTz(db);
  const today = localDate(new Date(), tz);
  await ensureSessions(db, svc, venue, today, addDays(today, SESSION_WINDOW_DAYS - 1), tz);
}

/** Re-run session generation for every session service at a venue. */
export async function refreshVenueSessions(db: DbOrTx, venueId: string): Promise<void> {
  const tz = await orgTz(db);
  const today = localDate(new Date(), tz);
  await ensureVenueSessions(db, venueId, today, addDays(today, SESSION_WINDOW_DAYS - 1), tz);
}

// ---------- services ----------

const serviceFields = {
  name: zf.text("Name", 120),
  blurb: zf.optText("Description", 1000),
  roomId: zf.uuid("Room"),
  lengthMinutes: zf.int("Length (minutes)", 5, 24 * 60),
  slotIntervalMinutes: zf.int("Start times every (minutes)", 5, 240),
  leadTimeMinutes: zf.int("Notice needed", 0, 60 * 24 * 365),
  cutoffMinutes: zf.int("Booking closes (minutes before)", 0, 60 * 24 * 30),
  onlineEnabled: z.boolean(),
  payInStoreEnabled: z.boolean(),
  inStoreNoteLine: zf.optText("In-store note (line)", 300),
  inStoreNoteShort: zf.optText("In-store note (short)", 300),
  inStoreMenuUrl: zf.optUrl("Menu link"),
  colour: zf.colour(),
};

export const createServiceSchema = z.object({
  venueId: zf.uuid("Venue"),
  kind: z.enum(["session", "slot"], { error: "Kind: choose workshop session or party slot." }),
  name: serviceFields.name,
  blurb: serviceFields.blurb,
  roomId: serviceFields.roomId,
  lengthMinutes: serviceFields.lengthMinutes,
  slotIntervalMinutes: serviceFields.slotIntervalMinutes.default(30),
  leadTimeMinutes: serviceFields.leadTimeMinutes.default(0),
  cutoffMinutes: serviceFields.cutoffMinutes.default(60),
  onlineEnabled: z.boolean().default(true),
  payInStoreEnabled: z.boolean().default(false),
  colour: serviceFields.colour.default("#5bbf3a"),
});
export type CreateServiceInput = z.input<typeof createServiceSchema>;

export const updateServiceSchema = z.object(serviceFields).partial();
export type UpdateServiceInput = z.input<typeof updateServiceSchema>;

export async function createService(db: DbOrTx, user: CurrentUser, input: CreateServiceInput): Promise<s.Service> {
  const data = parseInput(createServiceSchema, input);
  assertCanManage(user, data.venueId);
  await loadVenue(db, data.venueId);
  await assertRoomInVenue(db, data.roomId, data.venueId);
  return db.transaction(async (tx) => {
    const existing = await tx.select({ slug: s.services.slug, sortOrder: s.services.sortOrder }).from(s.services).where(eq(s.services.venueId, data.venueId));
    const slug = uniqueSlug(slugify(data.name), existing.map((r) => r.slug));
    const sortOrder = existing.reduce((m, r) => Math.max(m, r.sortOrder + 1), 0);
    const [row] = await tx
      .insert(s.services)
      .values({ ...data, blurb: data.blurb ?? null, slug, sortOrder })
      .returning();
    await audit(tx, { user, action: "service.create", entityType: "service", entityId: row.id, venueId: row.venueId, after: row });
    return row;
  });
}

export async function updateService(db: DbOrTx, user: CurrentUser, serviceId: string, input: UpdateServiceInput): Promise<s.Service> {
  const before = await loadService(db, user, serviceId);
  const patch = defined(parseInput(updateServiceSchema, input));
  if (patch.roomId) await assertRoomInVenue(db, patch.roomId, before.venueId);
  const after = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(s.services)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(s.services.id, serviceId))
      .returning();
    await audit(tx, { user, action: "service.update", entityType: "service", entityId: row.id, venueId: row.venueId, before, after: row });
    return row;
  });
  if (after.kind === "session" && (patch.roomId !== undefined || patch.lengthMinutes !== undefined)) {
    await refreshServiceSessions(db, after.id);
  }
  return after;
}

export async function setServiceArchived(db: DbOrTx, user: CurrentUser, serviceId: string, archived: boolean): Promise<s.Service> {
  const before = await loadService(db, user, serviceId);
  const after = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(s.services)
      .set({ archivedAt: archived ? (before.archivedAt ?? new Date()) : null, updatedAt: new Date() })
      .where(eq(s.services.id, serviceId))
      .returning();
    await audit(tx, {
      user,
      action: archived ? "service.archive" : "service.restore",
      entityType: "service",
      entityId: row.id,
      venueId: row.venueId,
      before: { archivedAt: before.archivedAt },
      after: { archivedAt: row.archivedAt },
    });
    return row;
  });
  if (!archived) await refreshServiceSessions(db, after.id);
  return after;
}

/** Move a service one place up or down among the venue's live services (sortOrder swap). */
export async function moveService(db: DbOrTx, user: CurrentUser, serviceId: string, direction: "up" | "down"): Promise<void> {
  const svc = await loadService(db, user, serviceId);
  const list = await db
    .select()
    .from(s.services)
    .where(and(eq(s.services.venueId, svc.venueId), isNull(s.services.archivedAt)))
    .orderBy(asc(s.services.sortOrder), asc(s.services.name));
  const i = list.findIndex((x) => x.id === svc.id);
  const j = direction === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= list.length) return;
  const before = list.map((x) => ({ id: x.id, name: x.name, sortOrder: x.sortOrder }));
  const order = [...list];
  [order[i], order[j]] = [order[j], order[i]];
  await db.transaction(async (tx) => {
    for (let k = 0; k < order.length; k++) {
      if (order[k].sortOrder !== k) {
        await tx.update(s.services).set({ sortOrder: k, updatedAt: new Date() }).where(eq(s.services.id, order[k].id));
      }
    }
    await audit(tx, {
      user,
      action: "service.reorder",
      entityType: "service",
      entityId: svc.id,
      venueId: svc.venueId,
      before,
      after: order.map((x, k) => ({ id: x.id, name: x.name, sortOrder: k })),
    });
  });
}

// ---------- options ----------

const optionFields = {
  name: zf.text("Name", 120),
  blurb: zf.optText("Description", 1000),
  unitPricePence: zf.int("Price", 0, 10_000_00),
  includedChildren: zf.int("Children included", 1, 200).nullable(),
  maxPerBooking: zf.int("Most per booking", 1, 200).nullable(),
  inStoreNoteLine: zf.optText("In-store note (line)", 300),
  inStoreNoteShort: zf.optText("In-store note (short)", 300),
  inStoreMenuUrl: zf.optUrl("Menu link"),
};
export const createOptionSchema = z.object({
  ...optionFields,
  includedChildren: optionFields.includedChildren.optional(),
  maxPerBooking: optionFields.maxPerBooking.optional(),
});
export type CreateOptionInput = z.input<typeof createOptionSchema>;
export const updateOptionSchema = z.object(optionFields).partial();
export type UpdateOptionInput = z.input<typeof updateOptionSchema>;

async function loadOption(db: DbOrTx, user: CurrentUser, optionId: string): Promise<{ option: s.ServiceOption; service: s.Service }> {
  if (!isUuid(optionId)) throw new AdminError("That option no longer exists.");
  const [option] = await db.select().from(s.serviceOptions).where(eq(s.serviceOptions.id, optionId)).limit(1);
  if (!option) throw new AdminError("That option no longer exists.");
  const service = await loadService(db, user, option.serviceId);
  return { option, service };
}

export async function createOption(db: DbOrTx, user: CurrentUser, serviceId: string, input: CreateOptionInput): Promise<s.ServiceOption> {
  const service = await loadService(db, user, serviceId);
  const data = parseInput(createOptionSchema, input);
  return db.transaction(async (tx) => {
    const [{ m }] = await tx.select({ m: max(s.serviceOptions.sortOrder) }).from(s.serviceOptions).where(eq(s.serviceOptions.serviceId, serviceId));
    const [row] = await tx
      .insert(s.serviceOptions)
      .values({
        ...data,
        blurb: data.blurb ?? null,
        includedChildren: data.includedChildren ?? null,
        maxPerBooking: data.maxPerBooking ?? null,
        inStoreNoteLine: data.inStoreNoteLine ?? null,
        inStoreNoteShort: data.inStoreNoteShort ?? null,
        inStoreMenuUrl: data.inStoreMenuUrl ?? null,
        serviceId,
        sortOrder: m === null ? 0 : Number(m) + 1,
      })
      .returning();
    await audit(tx, { user, action: "option.create", entityType: "service_option", entityId: row.id, venueId: service.venueId, after: row });
    return row;
  });
}

export async function updateOption(db: DbOrTx, user: CurrentUser, optionId: string, input: UpdateOptionInput): Promise<s.ServiceOption> {
  const { option: before, service } = await loadOption(db, user, optionId);
  const patch = defined(parseInput(updateOptionSchema, input));
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(s.serviceOptions)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(s.serviceOptions.id, optionId))
      .returning();
    await audit(tx, { user, action: "option.update", entityType: "service_option", entityId: row.id, venueId: service.venueId, before, after: row });
    return row;
  });
}

export async function setOptionArchived(db: DbOrTx, user: CurrentUser, optionId: string, archived: boolean): Promise<s.ServiceOption> {
  const { option: before, service } = await loadOption(db, user, optionId);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(s.serviceOptions)
      .set({ archivedAt: archived ? (before.archivedAt ?? new Date()) : null, updatedAt: new Date() })
      .where(eq(s.serviceOptions.id, optionId))
      .returning();
    await audit(tx, {
      user,
      action: archived ? "option.archive" : "option.restore",
      entityType: "service_option",
      entityId: row.id,
      venueId: service.venueId,
      before: { name: before.name, archivedAt: before.archivedAt },
      after: { name: row.name, archivedAt: row.archivedAt },
    });
    return row;
  });
}

// ---------- add-ons ----------

const addOnFields = {
  name: zf.text("Name", 120),
  blurb: zf.optText("Description", 1000),
  pricePence: zf.int("Price", 0, 10_000_00),
  kind: z.enum(["quantity", "time"], { error: "Kind: choose quantity or extra time." }),
  extraMinutes: zf.int("Extra minutes", 0, 600),
  maxQuantity: zf.int("Most per booking", 1, 200),
  perChild: z.boolean(),
};
export const createAddOnSchema = z
  .object({
    ...addOnFields,
    kind: addOnFields.kind.default("quantity"),
    extraMinutes: addOnFields.extraMinutes.default(0),
    maxQuantity: addOnFields.maxQuantity.default(1),
    perChild: z.boolean().default(false),
  })
  .refine((v) => v.kind !== "time" || v.extraMinutes > 0, "Extra minutes: a time add-on needs some extra minutes.");
export type CreateAddOnInput = z.input<typeof createAddOnSchema>;
export const updateAddOnSchema = z.object(addOnFields).partial();
export type UpdateAddOnInput = z.input<typeof updateAddOnSchema>;

async function loadAddOn(db: DbOrTx, user: CurrentUser, addOnId: string): Promise<{ addOn: s.AddOn; service: s.Service }> {
  if (!isUuid(addOnId)) throw new AdminError("That add-on no longer exists.");
  const [addOn] = await db.select().from(s.addOns).where(eq(s.addOns.id, addOnId)).limit(1);
  if (!addOn) throw new AdminError("That add-on no longer exists.");
  const service = await loadService(db, user, addOn.serviceId);
  return { addOn, service };
}

export async function createAddOn(db: DbOrTx, user: CurrentUser, serviceId: string, input: CreateAddOnInput): Promise<s.AddOn> {
  const service = await loadService(db, user, serviceId);
  const data = parseInput(createAddOnSchema, input);
  return db.transaction(async (tx) => {
    const [{ m }] = await tx.select({ m: max(s.addOns.sortOrder) }).from(s.addOns).where(eq(s.addOns.serviceId, serviceId));
    const [row] = await tx
      .insert(s.addOns)
      .values({
        ...data,
        blurb: data.blurb ?? null,
        extraMinutes: data.kind === "time" ? data.extraMinutes : 0,
        serviceId,
        sortOrder: m === null ? 0 : Number(m) + 1,
      })
      .returning();
    await audit(tx, { user, action: "addon.create", entityType: "add_on", entityId: row.id, venueId: service.venueId, after: row });
    return row;
  });
}

export async function updateAddOn(db: DbOrTx, user: CurrentUser, addOnId: string, input: UpdateAddOnInput): Promise<s.AddOn> {
  const { addOn: before, service } = await loadAddOn(db, user, addOnId);
  const patch = defined(parseInput(updateAddOnSchema, input));
  const kind = patch.kind ?? before.kind;
  const extra = patch.extraMinutes ?? before.extraMinutes;
  if (kind === "time" && extra <= 0) throw new AdminError("Extra minutes: a time add-on needs some extra minutes.");
  if (kind === "quantity") patch.extraMinutes = 0;
  return db.transaction(async (tx) => {
    const [row] = await tx.update(s.addOns).set({ ...patch, updatedAt: new Date() }).where(eq(s.addOns.id, addOnId)).returning();
    await audit(tx, { user, action: "addon.update", entityType: "add_on", entityId: row.id, venueId: service.venueId, before, after: row });
    return row;
  });
}

export async function setAddOnArchived(db: DbOrTx, user: CurrentUser, addOnId: string, archived: boolean): Promise<s.AddOn> {
  const { addOn: before, service } = await loadAddOn(db, user, addOnId);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(s.addOns)
      .set({ archivedAt: archived ? (before.archivedAt ?? new Date()) : null, updatedAt: new Date() })
      .where(eq(s.addOns.id, addOnId))
      .returning();
    await audit(tx, {
      user,
      action: archived ? "addon.archive" : "addon.restore",
      entityType: "add_on",
      entityId: row.id,
      venueId: service.venueId,
      before: { name: before.name, archivedAt: before.archivedAt },
      after: { name: row.name, archivedAt: row.archivedAt },
    });
    return row;
  });
}

// ---------- timetable rules ----------

function assertSessionService(service: s.Service): void {
  if (service.kind !== "session") throw new AdminError("Only workshop sessions have a timetable. Party start times come from opening hours.");
}

export const addRulesSchema = z
  .object({
    weekdays: z
      .array(z.number().int().min(0).max(6), { error: "Days: tick at least one day." })
      .min(1, "Days: tick at least one day."),
    startTime: zf.time("Start time"),
    capacity: zf.int("Places", 1, 500),
    validFrom: zf.date("From").nullish(),
    validTo: zf.date("Until").nullish(),
  })
  .refine((v) => !v.validFrom || !v.validTo || v.validFrom <= v.validTo, "Until must be on or after From.");
export type AddRulesInput = z.input<typeof addRulesSchema>;

/** Add one rule per ticked weekday. Exact duplicates are skipped. */
export async function addTimetableRules(db: DbOrTx, user: CurrentUser, serviceId: string, input: AddRulesInput): Promise<{ added: number; skipped: number }> {
  const service = await loadService(db, user, serviceId);
  assertSessionService(service);
  const data = parseInput(addRulesSchema, input);
  const validFrom = data.validFrom ?? null;
  const validTo = data.validTo ?? null;
  const existing = await db.select().from(s.timetableRules).where(eq(s.timetableRules.serviceId, serviceId));
  const weekdays = Array.from(new Set(data.weekdays));
  const toAdd = weekdays.filter(
    (w) => !existing.some((r) => r.weekday === w && r.startTime === data.startTime && r.validFrom === validFrom && r.validTo === validTo),
  );
  if (toAdd.length) {
    await db.transaction(async (tx) => {
      const rows = await tx
        .insert(s.timetableRules)
        .values(toAdd.map((weekday) => ({ serviceId, weekday, startTime: data.startTime, capacity: data.capacity, validFrom, validTo })))
        .returning();
      await audit(tx, { user, action: "timetable.add", entityType: "timetable_rule", entityId: serviceId, venueId: service.venueId, after: rows });
    });
    await refreshServiceSessions(db, serviceId);
  }
  return { added: toAdd.length, skipped: weekdays.length - toAdd.length };
}

async function loadRule(db: DbOrTx, user: CurrentUser, ruleId: string): Promise<{ rule: s.TimetableRule; service: s.Service }> {
  if (!isUuid(ruleId)) throw new AdminError("That time no longer exists.");
  const [rule] = await db.select().from(s.timetableRules).where(eq(s.timetableRules.id, ruleId)).limit(1);
  if (!rule) throw new AdminError("That time no longer exists.");
  const service = await loadService(db, user, rule.serviceId);
  return { rule, service };
}

export async function updateTimetableRuleCapacity(db: DbOrTx, user: CurrentUser, ruleId: string, capacity: number): Promise<s.TimetableRule> {
  const { rule: before, service } = await loadRule(db, user, ruleId);
  const cap = parseInput(zf.int("Places", 1, 500), capacity);
  const row = await db.transaction(async (tx) => {
    const [r] = await tx.update(s.timetableRules).set({ capacity: cap }).where(eq(s.timetableRules.id, ruleId)).returning();
    await audit(tx, { user, action: "timetable.capacity", entityType: "timetable_rule", entityId: r.id, venueId: service.venueId, before, after: r });
    return r;
  });
  await refreshServiceSessions(db, service.id);
  return row;
}

export async function deleteTimetableRule(db: DbOrTx, user: CurrentUser, ruleId: string): Promise<void> {
  const { rule, service } = await loadRule(db, user, ruleId);
  await db.transaction(async (tx) => {
    await tx.delete(s.timetableRules).where(eq(s.timetableRules.id, ruleId));
    await audit(tx, { user, action: "timetable.delete", entityType: "timetable_rule", entityId: rule.id, venueId: service.venueId, before: rule });
  });
  await refreshServiceSessions(db, service.id);
}

/** Pure: hourly start times from opening to one length before closing. */
export function hourlyStarts(hours: { open: string; close: string } | null, lengthMinutes: number): string[] {
  if (!hours) return [];
  const open = timeToMinutes(hours.open);
  const lastStart = timeToMinutes(hours.close) - lengthMinutes;
  const out: string[] = [];
  for (let m = open; m <= lastStart; m += 60) out.push(minutesToTime(m));
  return out;
}

/**
 * Create hourly rules from the venue's opening hours, to one length before
 * closing. Adds only the weekday + time pairs that have no rule yet.
 */
export async function fillTimetableFromOpeningHours(
  db: DbOrTx,
  user: CurrentUser,
  serviceId: string,
  input: { capacity?: number } = {},
): Promise<{ added: number }> {
  const service = await loadService(db, user, serviceId);
  assertSessionService(service);
  const venue = await loadVenue(db, service.venueId);
  const existing = await db.select().from(s.timetableRules).where(eq(s.timetableRules.serviceId, serviceId));
  const capacity =
    input.capacity !== undefined ? parseInput(zf.int("Places", 1, 500), input.capacity) : mostCommon(existing.map((r) => r.capacity)) ?? 10;
  const rows: (typeof s.timetableRules.$inferInsert)[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    for (const startTime of hourlyStarts(venue.openingHours[WEEKDAY_KEYS[weekday]], service.lengthMinutes)) {
      if (existing.some((r) => r.weekday === weekday && r.startTime === startTime)) continue;
      rows.push({ serviceId, weekday, startTime, capacity });
    }
  }
  if (rows.length) {
    await db.transaction(async (tx) => {
      const inserted = await tx.insert(s.timetableRules).values(rows).returning();
      await audit(tx, { user, action: "timetable.fill", entityType: "timetable_rule", entityId: serviceId, venueId: service.venueId, after: inserted });
    });
    await refreshServiceSessions(db, serviceId);
  }
  return { added: rows.length };
}

function mostCommon(values: number[]): number | null {
  if (!values.length) return null;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}

// ---------- timetable exceptions ----------

export const EXCEPTION_KINDS = {
  cancel_day: "Cancel the whole day",
  cancel_time: "Cancel one time",
  add: "Add a session",
  capacity: "Change places for one time",
} as const;
export type ExceptionChoice = keyof typeof EXCEPTION_KINDS;

export const addExceptionSchema = z
  .object({
    date: zf.date("Date"),
    kind: z.enum(["cancel_day", "cancel_time", "add", "capacity"], { error: "What: choose one." }),
    startTime: zf.time("Time").nullish(),
    capacity: zf.int("Places", 0, 500).nullish(),
    note: zf.optText("Note", 300),
  })
  .refine((v) => v.kind === "cancel_day" || Boolean(v.startTime), "Time: pick the time this applies to.")
  .refine((v) => (v.kind !== "add" && v.kind !== "capacity") || (v.capacity !== null && v.capacity !== undefined), "Places: say how many places.");
export type AddExceptionInput = z.input<typeof addExceptionSchema>;

export async function addTimetableException(
  db: DbOrTx,
  user: CurrentUser,
  serviceId: string,
  input: AddExceptionInput,
): Promise<{ exception: s.TimetableException; keptWithBookings: number }> {
  const service = await loadService(db, user, serviceId);
  assertSessionService(service);
  const data = parseInput(addExceptionSchema, input);
  const tz = await orgTz(db);
  const today = localDate(new Date(), tz);
  if (data.date < today) throw new AdminError("Date: pick today or a later date.");
  const kind: s.TimetableException["kind"] = data.kind === "cancel_day" || data.kind === "cancel_time" ? "cancel" : data.kind;
  const startTime = data.kind === "cancel_day" ? null : (data.startTime ?? null);
  const exception = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(s.timetableExceptions)
      .values({
        serviceId,
        date: data.date,
        startTime,
        kind,
        capacity: kind === "cancel" ? null : (data.capacity ?? null),
        note: data.note ?? null,
        createdBy: user.id,
      })
      .returning();
    await audit(tx, { user, action: "exception.add", entityType: "timetable_exception", entityId: row.id, venueId: service.venueId, after: row });
    return row;
  });
  await refreshServiceSessions(db, serviceId);

  let keptWithBookings = 0;
  if (kind === "cancel") {
    const start = startTime ? zonedDateTime(data.date, startTime, tz) : startOfLocalDay(data.date, tz);
    const end = startTime ? new Date(start.getTime() + 1) : endOfLocalDay(data.date, tz);
    const rows = await db
      .select({ id: s.sessions.id })
      .from(s.sessions)
      .innerJoin(s.bookings, eq(s.bookings.sessionId, s.sessions.id))
      .where(
        and(
          eq(s.sessions.serviceId, serviceId),
          eq(s.sessions.status, "scheduled"),
          gte(s.sessions.startsAt, start),
          lt(s.sessions.startsAt, end),
          inArray(s.bookings.status, ["pending", "confirmed"]),
        ),
      );
    keptWithBookings = new Set(rows.map((r) => r.id)).size;
  }
  return { exception, keptWithBookings };
}

export async function deleteTimetableException(db: DbOrTx, user: CurrentUser, exceptionId: string): Promise<void> {
  if (!isUuid(exceptionId)) throw new AdminError("That change no longer exists.");
  const [row] = await db.select().from(s.timetableExceptions).where(eq(s.timetableExceptions.id, exceptionId)).limit(1);
  if (!row) throw new AdminError("That change no longer exists.");
  const service = await loadService(db, user, row.serviceId);
  await db.transaction(async (tx) => {
    await tx.delete(s.timetableExceptions).where(eq(s.timetableExceptions.id, exceptionId));
    await audit(tx, { user, action: "exception.delete", entityType: "timetable_exception", entityId: row.id, venueId: service.venueId, before: row });
  });
  await refreshServiceSessions(db, service.id);
}

/** Exceptions on or after `fromDate`, soonest first. */
export async function listUpcomingExceptions(db: DbOrTx, serviceId: string, fromDate: string): Promise<s.TimetableException[]> {
  if (!isUuid(serviceId)) return [];
  return db
    .select()
    .from(s.timetableExceptions)
    .where(and(eq(s.timetableExceptions.serviceId, serviceId), gte(s.timetableExceptions.date, fromDate)))
    .orderBy(asc(s.timetableExceptions.date), asc(s.timetableExceptions.startTime));
}

// ---------- blocks ----------

export const createBlockSchema = z
  .object({
    venueId: zf.uuid("Venue"),
    roomId: zf.uuid("Room").nullable(),
    startDate: zf.date("Start date"),
    startTime: zf.time("Start time"),
    endDate: zf.date("End date"),
    endTime: zf.time("End time"),
    reason: zf.text("Reason", 200),
  })
  .refine((v) => `${v.endDate} ${v.endTime}` > `${v.startDate} ${v.startTime}`, "The end must be after the start.");
export type CreateBlockInput = z.input<typeof createBlockSchema>;

async function countOverlappingBookings(db: DbOrTx, venueId: string, roomId: string | null, start: Date, end: Date): Promise<number> {
  const conds = [
    eq(s.bookings.venueId, venueId),
    inArray(s.bookings.status, ["pending", "confirmed"]),
    lt(s.bookings.startsAt, end),
    gt(s.bookings.endsAt, start),
  ];
  if (roomId) conds.push(eq(s.bookings.roomId, roomId));
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(s.bookings).where(and(...conds));
  return Number(n);
}

export async function createBlock(db: DbOrTx, user: CurrentUser, input: CreateBlockInput): Promise<{ block: s.Block; overlappingBookings: number }> {
  const data = parseInput(createBlockSchema, input);
  assertCanManage(user, data.venueId);
  await loadVenue(db, data.venueId);
  if (data.roomId) await assertRoomInVenue(db, data.roomId, data.venueId);
  const tz = await orgTz(db);
  // "24:00" is not a valid time input; an end of 00:00 on a later day covers the whole previous day.
  const startsAt = zonedDateTime(data.startDate, data.startTime, tz);
  const endsAt = zonedDateTime(data.endDate, data.endTime, tz);
  if (endsAt <= startsAt) throw new AdminError("The end must be after the start.");
  const block = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(s.blocks)
      .values({ venueId: data.venueId, roomId: data.roomId, startsAt, endsAt, reason: data.reason, createdBy: user.id })
      .returning();
    await audit(tx, { user, action: "block.create", entityType: "block", entityId: row.id, venueId: row.venueId, after: row });
    return row;
  });
  const overlappingBookings = await countOverlappingBookings(db, data.venueId, data.roomId, startsAt, endsAt);
  return { block, overlappingBookings };
}

/** Close a whole local day at a venue: 00:00 to 00:00 the next day. */
export async function closeWholeDay(
  db: DbOrTx,
  user: CurrentUser,
  input: { venueId: string; date: string; reason?: string },
): Promise<{ block: s.Block; overlappingBookings: number }> {
  const date = parseInput(zf.date("Date"), input.date);
  return createBlock(db, user, {
    venueId: input.venueId,
    roomId: null,
    startDate: date,
    startTime: "00:00",
    endDate: addDays(date, 1),
    endTime: "00:00",
    reason: input.reason?.trim() || "Closed",
  });
}

export async function deleteBlock(db: DbOrTx, user: CurrentUser, blockId: string): Promise<void> {
  if (!isUuid(blockId)) throw new AdminError("That blocked time no longer exists.");
  const [row] = await db.select().from(s.blocks).where(eq(s.blocks.id, blockId)).limit(1);
  if (!row || !canAccessVenue(user, row.venueId)) throw new AdminError("That blocked time no longer exists.");
  assertCanManage(user, row.venueId);
  await db.transaction(async (tx) => {
    await tx.delete(s.blocks).where(eq(s.blocks.id, blockId));
    await audit(tx, { user, action: "block.delete", entityType: "block", entityId: row.id, venueId: row.venueId, before: row });
  });
}

export type BlockRow = s.Block & { roomName: string | null };

/** Blocks that have not ended yet, soonest first. */
export async function listUpcomingBlocks(db: DbOrTx, venueIds: string[], now = new Date()): Promise<BlockRow[]> {
  if (!venueIds.length) return [];
  const rows = await db
    .select({ block: s.blocks, roomName: s.rooms.name })
    .from(s.blocks)
    .leftJoin(s.rooms, eq(s.rooms.id, s.blocks.roomId))
    .where(and(inArray(s.blocks.venueId, venueIds), gt(s.blocks.endsAt, now)))
    .orderBy(asc(s.blocks.startsAt));
  return rows.map((r) => ({ ...r.block, roomName: r.roomName ?? null }));
}

// ---------- single session occurrences ----------

export type DaySession = {
  id: string;
  serviceId: string;
  serviceName: string;
  colour: string;
  roomName: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  status: s.Session["status"];
  source: s.Session["source"];
  pinned: boolean;
  /** Places on pending + confirmed bookings. */
  taken: number;
  /** Confirmed bookings (not places). */
  confirmedBookings: number;
};

/** Every session occurrence at a venue on one local day, cancelled ones included. */
export async function listSessionsForDay(db: DbOrTx, venueId: string, date: string, tz: string): Promise<DaySession[]> {
  if (!isUuid(venueId) || !isValidDateStr(date)) return [];
  await ensureVenueSessions(db, venueId, date, date, tz);
  const rows = await db
    .select({
      id: s.sessions.id,
      serviceId: s.sessions.serviceId,
      serviceName: s.services.name,
      colour: s.services.colour,
      roomName: s.rooms.name,
      startsAt: s.sessions.startsAt,
      endsAt: s.sessions.endsAt,
      capacity: s.sessions.capacity,
      status: s.sessions.status,
      source: s.sessions.source,
      pinned: s.sessions.pinned,
    })
    .from(s.sessions)
    .innerJoin(s.services, eq(s.services.id, s.sessions.serviceId))
    .innerJoin(s.rooms, eq(s.rooms.id, s.sessions.roomId))
    .where(and(eq(s.sessions.venueId, venueId), gte(s.sessions.startsAt, startOfLocalDay(date, tz)), lt(s.sessions.startsAt, endOfLocalDay(date, tz))))
    .orderBy(asc(s.sessions.startsAt), asc(s.services.sortOrder));
  const ids = rows.map((r) => r.id);
  const counts = ids.length
    ? await db
        .select({
          sessionId: s.bookings.sessionId,
          places: sql<number>`coalesce(sum(${s.bookings.places}), 0)`,
          confirmed: sql<number>`count(*) filter (where ${s.bookings.status} = 'confirmed')`,
        })
        .from(s.bookings)
        .where(and(inArray(s.bookings.sessionId, ids), inArray(s.bookings.status, ["pending", "confirmed"])))
        .groupBy(s.bookings.sessionId)
    : [];
  const byId = new Map(counts.map((c) => [c.sessionId, c]));
  return rows.map((r) => ({ ...r, taken: Number(byId.get(r.id)?.places ?? 0), confirmedBookings: Number(byId.get(r.id)?.confirmed ?? 0) }));
}

async function loadSession(db: DbOrTx, user: CurrentUser, sessionId: string): Promise<s.Session> {
  if (!isUuid(sessionId)) throw new AdminError("That session no longer exists.");
  const [row] = await db.select().from(s.sessions).where(eq(s.sessions.id, sessionId)).limit(1);
  if (!row || !canAccessVenue(user, row.venueId)) throw new AdminError("That session no longer exists.");
  assertCanManage(user, row.venueId);
  return row;
}

async function sessionCounts(db: DbOrTx, sessionId: string): Promise<{ places: number; confirmed: number }> {
  const [r] = await db
    .select({
      places: sql<number>`coalesce(sum(${s.bookings.places}), 0)`,
      confirmed: sql<number>`count(*) filter (where ${s.bookings.status} = 'confirmed')`,
    })
    .from(s.bookings)
    .where(and(eq(s.bookings.sessionId, sessionId), inArray(s.bookings.status, ["pending", "confirmed"])));
  return { places: Number(r?.places ?? 0), confirmed: Number(r?.confirmed ?? 0) };
}

/** Change one occurrence's places. Pins it so the timetable leaves it alone. */
export async function setSessionCapacity(db: DbOrTx, user: CurrentUser, sessionId: string, capacity: number): Promise<s.Session> {
  const before = await loadSession(db, user, sessionId);
  const cap = parseInput(zf.int("Places", 0, 500), capacity);
  const { places } = await sessionCounts(db, sessionId);
  if (cap < places) throw new AdminError(`${places} ${places === 1 ? "place is" : "places are"} already booked, so places cannot go below ${places}.`);
  return db.transaction(async (tx) => {
    const [row] = await tx.update(s.sessions).set({ capacity: cap, pinned: true, updatedAt: new Date() }).where(eq(s.sessions.id, sessionId)).returning();
    await audit(tx, {
      user,
      action: "session.capacity",
      entityType: "session",
      entityId: row.id,
      venueId: row.venueId,
      before: { capacity: before.capacity, pinned: before.pinned },
      after: { capacity: row.capacity, pinned: row.pinned },
    });
    return row;
  });
}

/**
 * Cancel one occurrence (no new bookings). Refused while it has confirmed
 * bookings unless the user confirms they will move or cancel them.
 */
export async function cancelSession(
  db: DbOrTx,
  user: CurrentUser,
  sessionId: string,
  opts: { bookingsAcknowledged?: boolean } = {},
): Promise<s.Session> {
  const before = await loadSession(db, user, sessionId);
  const { confirmed } = await sessionCounts(db, sessionId);
  if (confirmed > 0 && !opts.bookingsAcknowledged) {
    throw new AdminError(
      `This session has ${confirmed} ${confirmed === 1 ? "booking" : "bookings"}. Tick "I will move or cancel the ${confirmed === 1 ? "booking" : `${confirmed} bookings`} myself" to cancel it.`,
    );
  }
  return db.transaction(async (tx) => {
    const [row] = await tx.update(s.sessions).set({ status: "cancelled", pinned: true, updatedAt: new Date() }).where(eq(s.sessions.id, sessionId)).returning();
    await audit(tx, {
      user,
      action: "session.cancel",
      entityType: "session",
      entityId: row.id,
      venueId: row.venueId,
      before: { status: before.status, pinned: before.pinned },
      after: { status: row.status, pinned: row.pinned, confirmedBookings: confirmed },
    });
    return row;
  });
}

/** Put a cancelled occurrence back on. */
export async function restoreSession(db: DbOrTx, user: CurrentUser, sessionId: string): Promise<s.Session> {
  const before = await loadSession(db, user, sessionId);
  return db.transaction(async (tx) => {
    const [row] = await tx.update(s.sessions).set({ status: "scheduled", pinned: true, updatedAt: new Date() }).where(eq(s.sessions.id, sessionId)).returning();
    await audit(tx, {
      user,
      action: "session.restore",
      entityType: "session",
      entityId: row.id,
      venueId: row.venueId,
      before: { status: before.status },
      after: { status: row.status },
    });
    return row;
  });
}

export const extraSessionSchema = z.object({
  date: zf.date("Date"),
  startTime: zf.time("Start time"),
  capacity: zf.int("Places", 1, 500),
  note: zf.optText("Note", 300),
});
export type ExtraSessionInput = z.input<typeof extraSessionSchema>;

/** Add an extra occurrence: a timetable exception `add`, then materialise it. */
export async function addExtraSession(db: DbOrTx, user: CurrentUser, serviceId: string, input: ExtraSessionInput): Promise<s.Session> {
  const service = await loadService(db, user, serviceId);
  assertSessionService(service);
  if (service.archivedAt) throw new AdminError("That service is archived. Restore it first.");
  const data = parseInput(extraSessionSchema, input);
  const tz = await orgTz(db);
  if (data.date < localDate(new Date(), tz)) throw new AdminError("Date: pick today or a later date.");
  const startsAt = zonedDateTime(data.date, data.startTime, tz);
  const [existing] = await db
    .select()
    .from(s.sessions)
    .where(and(eq(s.sessions.serviceId, serviceId), eq(s.sessions.startsAt, startsAt)))
    .limit(1);
  if (existing && existing.status === "scheduled") throw new AdminError(`There is already a ${service.name} session at ${data.startTime} that day.`);
  if (existing && existing.pinned) {
    // A cancelled, pinned occurrence: bring it back with the new capacity.
    const { places } = await sessionCounts(db, existing.id);
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(s.sessions)
        .set({ status: "scheduled", capacity: Math.max(data.capacity, places), updatedAt: new Date() })
        .where(eq(s.sessions.id, existing.id))
        .returning();
      await audit(tx, { user, action: "session.add", entityType: "session", entityId: row.id, venueId: row.venueId, before: existing, after: row });
      return row;
    });
  }
  await db.transaction(async (tx) => {
    const [ex] = await tx
      .insert(s.timetableExceptions)
      .values({ serviceId, date: data.date, startTime: data.startTime, kind: "add", capacity: data.capacity, note: data.note ?? null, createdBy: user.id })
      .returning();
    await audit(tx, { user, action: "session.add", entityType: "timetable_exception", entityId: ex.id, venueId: service.venueId, after: ex });
  });
  const venue = await loadVenue(db, service.venueId);
  await ensureSessions(db, service, venue, data.date, data.date, tz);
  const [row] = await db
    .select()
    .from(s.sessions)
    .where(and(eq(s.sessions.serviceId, serviceId), eq(s.sessions.startsAt, startsAt)))
    .limit(1);
  if (!row) {
    throw new AdminError(
      venue.opensAt && startsAt < venue.opensAt ? "That date is before the venue opens." : "The session could not be added. Check the venue is not closed.",
    );
  }
  return row;
}
