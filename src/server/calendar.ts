/**
 * Calendar mirror: one-way push of bookings to a calendar per venue (Google in
 * live, the demo adapter otherwise). The admin is the source of truth; this
 * never throws. Every attempt lands in `calendar_log`, which the admin shows.
 */
import { and, desc, eq, gte, ilike, inArray, lt, or, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";
import { getCalendarProvider } from "@/providers";
import type { CalendarEventInput, CalendarProvider } from "@/providers/types";
import { isDemo } from "@/lib/env";
import { fmtPence } from "@/core/time";
import { adminBookingUrl, formatWhatBooked, paymentLineFor } from "./notifications";

export type CalendarAction = "create" | "update" | "delete";

type Loaded = { booking: s.Booking; venue: s.Venue; customer: s.Customer; service: s.Service };

async function load(db: DbOrTx, bookingId: string): Promise<Loaded | null> {
  const [booking] = await db.select().from(s.bookings).where(eq(s.bookings.id, bookingId)).limit(1);
  if (!booking) return null;
  const [[venue], [customer], [service]] = await Promise.all([
    db.select().from(s.venues).where(eq(s.venues.id, booking.venueId)).limit(1),
    db.select().from(s.customers).where(eq(s.customers.id, booking.customerId)).limit(1),
    db.select().from(s.services).where(eq(s.services.id, booking.serviceId)).limit(1),
  ]);
  if (!venue || !customer || !service) return null;
  return { booking, venue, customer, service };
}

export function calendarSummary(x: Pick<Loaded, "booking" | "customer" | "service">): string {
  const { booking, customer, service } = x;
  if (service.kind === "slot") {
    const who = booking.birthdayChildFirstName?.trim() || customer.lastName;
    return `${service.name}: ${who} (${booking.places} children)`;
  }
  return `${service.name} – ${customer.firstName} (${booking.places})`;
}

export function calendarDescription(x: Loaded): string {
  const { booking, customer } = x;
  const parts: string[] = [
    `Reference ${booking.reference}`,
    [
      `${customer.firstName} ${customer.lastName}`.trim(),
      customer.phone ? `Phone: ${customer.phone}` : "",
      customer.email ? `Email: ${customer.email}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    formatWhatBooked(booking),
    `Total ${fmtPence(booking.totalPence)} (${paymentLineFor(booking)})`,
  ];
  if (booking.birthdayChildFirstName) {
    parts.push(`Birthday child: ${booking.birthdayChildFirstName}${booking.birthdayChildAge ? `, age ${booking.birthdayChildAge}` : ""}`);
  }
  if (booking.notes?.trim()) parts.push(`Notes: ${booking.notes.trim()}`);
  if (booking.customerMessage?.trim()) parts.push(`Message from the customer: ${booking.customerMessage.trim()}`);
  parts.push(`Open in BayPook: ${adminBookingUrl(booking.id)}`);
  return parts.filter((p) => p.trim() !== "").join("\n\n");
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function writeLog(db: DbOrTx, row: typeof s.calendarLog.$inferInsert): Promise<s.CalendarLogRow> {
  const [inserted] = await db.insert(s.calendarLog).values(row).returning();
  return inserted;
}

/**
 * Push one booking to its venue calendar.
 *  - create: updates instead when the booking already has an event id; stores the new id
 *  - update: creates when there is no event id yet
 *  - delete: no-op when there is no event id; clears the id afterwards
 * Returns the `calendar_log` row written, or null when the booking does not exist.
 */
export async function syncBookingToCalendar(
  db: DbOrTx,
  bookingId: string,
  action: CalendarAction,
): Promise<s.CalendarLogRow | null> {
  let loaded: Loaded | null = null;
  let providerName: s.CalendarLogRow["provider"] = isDemo() ? "demo" : "google";
  try {
    loaded = await load(db, bookingId);
    if (!loaded) return null;
    const { booking, venue } = loaded;

    const resolved = await getCalendarProvider();
    const provider: CalendarProvider = resolved.provider;
    providerName = provider.name;
    const okStatus: s.CalendarLogRow["status"] = provider.name === "demo" ? "demo" : "ok";

    const calendarId = venue.googleCalendarId?.trim() || (isDemo() ? "demo" : null);
    if (!calendarId) {
      return await writeLog(db, {
        bookingId,
        venueId: venue.id,
        provider: provider.name,
        action,
        status: "failed",
        providerEventId: booking.googleEventId,
        payload: { requestedAction: action },
        error: "No calendar ID for venue",
      });
    }

    const input: CalendarEventInput = {
      calendarId,
      summary: calendarSummary(loaded),
      description: calendarDescription(loaded),
      location: [venue.name, venue.address].filter(Boolean).join(", "),
      start: booking.startsAt,
      end: booking.endsAt,
      bookingId: booking.id,
    };
    const payload = {
      requestedAction: action,
      calendarId,
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: input.start.toISOString(),
      end: input.end.toISOString(),
      fallback: resolved.fallback,
      ...(resolved.reason ? { reason: resolved.reason } : {}),
    };

    const existingId = booking.googleEventId;
    let performed: CalendarAction = action;
    let eventId: string | null = existingId;

    if (action === "delete") {
      if (!existingId) {
        return await writeLog(db, {
          bookingId,
          venueId: venue.id,
          provider: provider.name,
          action: "delete",
          status: okStatus,
          providerEventId: null,
          payload: { ...payload, note: "No calendar event to delete" },
          error: null,
        });
      }
      await provider.deleteEvent(calendarId, existingId);
      await db.update(s.bookings).set({ googleEventId: null }).where(eq(s.bookings.id, booking.id));
    } else if (existingId) {
      performed = "update";
      try {
        await provider.updateEvent(existingId, input);
      } catch (e) {
        // The event was removed by hand in the calendar: create it again.
        if (!/\b(404|410)\b/.test(errorMessage(e))) throw e;
        performed = "create";
        eventId = (await provider.createEvent(input)).eventId;
        await db.update(s.bookings).set({ googleEventId: eventId }).where(eq(s.bookings.id, booking.id));
      }
    } else {
      performed = "create";
      eventId = (await provider.createEvent(input)).eventId;
      await db.update(s.bookings).set({ googleEventId: eventId }).where(eq(s.bookings.id, booking.id));
    }

    return await writeLog(db, {
      bookingId,
      venueId: venue.id,
      provider: provider.name,
      action: performed,
      status: okStatus,
      providerEventId: eventId,
      payload,
      error: null,
    });
  } catch (e) {
    try {
      return await writeLog(db, {
        bookingId: loaded?.booking.id ?? null,
        venueId: loaded?.venue.id ?? null,
        provider: providerName,
        action,
        status: "failed",
        providerEventId: loaded?.booking.googleEventId ?? null,
        payload: { requestedAction: action },
        error: errorMessage(e),
      });
    } catch {
      return null;
    }
  }
}

/** The Calendar log, newest first. `venueIds: null/undefined` = every venue. */
export async function listCalendarLog(
  db: DbOrTx,
  opts: {
    venueIds?: string[] | null;
    limit?: number;
    bookingId?: string;
    /** Case-insensitive match on the booking reference or the calendar event id. */
    search?: string;
    /** Rows created at or after this instant. */
    from?: Date;
    /** Rows created before this instant (exclusive). */
    to?: Date;
  } = {},
): Promise<s.CalendarLogRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const where: SQL[] = [];
  if (Array.isArray(opts.venueIds)) {
    if (opts.venueIds.length === 0) return [];
    where.push(inArray(s.calendarLog.venueId, opts.venueIds));
  }
  if (opts.bookingId) where.push(eq(s.calendarLog.bookingId, opts.bookingId));
  const q = opts.search?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const cond = or(
      ilike(s.calendarLog.providerEventId, like),
      inArray(s.calendarLog.bookingId, db.select({ id: s.bookings.id }).from(s.bookings).where(ilike(s.bookings.reference, like))),
    );
    if (cond) where.push(cond);
  }
  if (opts.from) where.push(gte(s.calendarLog.createdAt, opts.from));
  if (opts.to) where.push(lt(s.calendarLog.createdAt, opts.to));
  return db
    .select()
    .from(s.calendarLog)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(s.calendarLog.createdAt))
    .limit(limit);
}
