/**
 * Shared loaders for the Today and Week views (and anything else that shows a
 * venue's day): sessions with places taken, party bookings and blocked time.
 */
import { and, asc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";
import { addDays, eachLocalDay, endOfLocalDay, localDate, startOfLocalDay } from "@/core/time";
import { ensureVenueSessions } from "@/server/sessions";

export const LIVE_BOOKING_STATUSES = ["pending", "confirmed"] as const;

export type SessionItem = {
  kind: "session";
  id: string;
  venueId: string;
  date: string;
  startsAt: Date;
  endsAt: Date;
  serviceId: string;
  serviceName: string;
  colour: string;
  roomName: string;
  capacity: number;
  /** Places on pending + confirmed bookings. */
  taken: number;
  status: "scheduled" | "cancelled";
  /** "Amira K." for each live booking, in booking order. */
  parents: string[];
};

export type PartyItem = {
  kind: "party";
  id: string;
  venueId: string;
  date: string;
  startsAt: Date;
  endsAt: Date;
  reference: string;
  serviceName: string;
  colour: string;
  roomName: string;
  status: s.Booking["status"];
  paymentStatus: s.Booking["paymentStatus"];
  places: number;
  birthdayChildFirstName: string | null;
  birthdayChildAge: number | null;
  parentName: string;
  phone: string | null;
};

export type BlockItem = {
  kind: "block";
  id: string;
  venueId: string;
  date: string;
  startsAt: Date;
  endsAt: Date;
  /** True when the block covers the whole local day. */
  allDay: boolean;
  reason: string;
  roomName: string | null;
};

export type ScheduleItem = SessionItem | PartyItem | BlockItem;

/** "Amira Khan" -> "Amira K." */
export function shortName(first: string, last: string): string {
  const f = first.trim();
  const l = last.trim();
  if (!l) return f || "Customer";
  return `${f} ${l[0].toUpperCase()}.`.trim();
}

export function isFull(item: Pick<SessionItem, "taken" | "capacity">): boolean {
  return item.capacity > 0 && item.taken >= item.capacity;
}

/**
 * Everything on the venues' calendars between two local dates (inclusive),
 * sorted by start time. Materialises sessions for the window first.
 */
export async function loadSchedule(
  db: DbOrTx,
  input: { venueIds: string[]; from: string; to: string; tz: string },
): Promise<ScheduleItem[]> {
  const { venueIds, from, to, tz } = input;
  if (!venueIds.length) return [];
  for (const id of venueIds) await ensureVenueSessions(db, id, from, to, tz);

  const windowStart = startOfLocalDay(from, tz);
  const windowEnd = endOfLocalDay(to, tz);

  const [sessionRows, partyRows, blockRows] = await Promise.all([
    db
      .select({
        id: s.sessions.id,
        venueId: s.sessions.venueId,
        startsAt: s.sessions.startsAt,
        endsAt: s.sessions.endsAt,
        capacity: s.sessions.capacity,
        status: s.sessions.status,
        serviceId: s.services.id,
        serviceName: s.services.name,
        colour: s.services.colour,
        roomName: s.rooms.name,
      })
      .from(s.sessions)
      .innerJoin(s.services, eq(s.services.id, s.sessions.serviceId))
      .innerJoin(s.rooms, eq(s.rooms.id, s.sessions.roomId))
      .where(and(inArray(s.sessions.venueId, venueIds), gte(s.sessions.startsAt, windowStart), lt(s.sessions.startsAt, windowEnd)))
      .orderBy(asc(s.sessions.startsAt)),
    db
      .select({
        id: s.bookings.id,
        venueId: s.bookings.venueId,
        startsAt: s.bookings.startsAt,
        endsAt: s.bookings.endsAt,
        reference: s.bookings.reference,
        status: s.bookings.status,
        paymentStatus: s.bookings.paymentStatus,
        places: s.bookings.places,
        birthdayChildFirstName: s.bookings.birthdayChildFirstName,
        birthdayChildAge: s.bookings.birthdayChildAge,
        serviceName: s.services.name,
        colour: s.services.colour,
        roomName: s.rooms.name,
        firstName: s.customers.firstName,
        lastName: s.customers.lastName,
        phone: s.customers.phone,
      })
      .from(s.bookings)
      .innerJoin(s.services, eq(s.services.id, s.bookings.serviceId))
      .innerJoin(s.rooms, eq(s.rooms.id, s.bookings.roomId))
      .innerJoin(s.customers, eq(s.customers.id, s.bookings.customerId))
      .where(
        and(
          inArray(s.bookings.venueId, venueIds),
          eq(s.services.kind, "slot"),
          inArray(s.bookings.status, ["pending", "confirmed", "no_show"]),
          gte(s.bookings.startsAt, windowStart),
          lt(s.bookings.startsAt, windowEnd),
        ),
      )
      .orderBy(asc(s.bookings.startsAt)),
    db
      .select({
        id: s.blocks.id,
        venueId: s.blocks.venueId,
        startsAt: s.blocks.startsAt,
        endsAt: s.blocks.endsAt,
        reason: s.blocks.reason,
        roomName: s.rooms.name,
      })
      .from(s.blocks)
      .leftJoin(s.rooms, eq(s.rooms.id, s.blocks.roomId))
      .where(and(inArray(s.blocks.venueId, venueIds), lt(s.blocks.startsAt, windowEnd), gt(s.blocks.endsAt, windowStart)))
      .orderBy(asc(s.blocks.startsAt)),
  ]);

  // Places taken and parent names per session.
  const sessionIds = sessionRows.map((r) => r.id);
  const byStatus = sessionIds.length
    ? await db
        .select({
          sessionId: s.bookings.sessionId,
          places: s.bookings.places,
          firstName: s.customers.firstName,
          lastName: s.customers.lastName,
        })
        .from(s.bookings)
        .innerJoin(s.customers, eq(s.customers.id, s.bookings.customerId))
        .where(and(inArray(s.bookings.sessionId, sessionIds), inArray(s.bookings.status, [...LIVE_BOOKING_STATUSES])))
        .orderBy(asc(s.bookings.createdAt))
    : [];
  const taken = new Map<string, { places: number; parents: string[] }>();
  for (const b of byStatus) {
    if (!b.sessionId) continue;
    const cur = taken.get(b.sessionId) ?? { places: 0, parents: [] };
    cur.places += b.places;
    cur.parents.push(shortName(b.firstName, b.lastName));
    taken.set(b.sessionId, cur);
  }

  const items: ScheduleItem[] = [];
  for (const r of sessionRows) {
    const t = taken.get(r.id);
    // Hide rule-cancelled sessions nobody is booked on.
    if (r.status === "cancelled" && !t) continue;
    items.push({
      kind: "session",
      id: r.id,
      venueId: r.venueId,
      date: localDate(r.startsAt, tz),
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      serviceId: r.serviceId,
      serviceName: r.serviceName,
      colour: r.colour,
      roomName: r.roomName,
      capacity: r.capacity,
      taken: t?.places ?? 0,
      status: r.status,
      parents: t?.parents ?? [],
    });
  }
  for (const r of partyRows) {
    items.push({
      kind: "party",
      id: r.id,
      venueId: r.venueId,
      date: localDate(r.startsAt, tz),
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      reference: r.reference,
      serviceName: r.serviceName,
      colour: r.colour,
      roomName: r.roomName,
      status: r.status,
      paymentStatus: r.paymentStatus,
      places: r.places,
      birthdayChildFirstName: r.birthdayChildFirstName,
      birthdayChildAge: r.birthdayChildAge,
      parentName: `${r.firstName} ${r.lastName}`.trim(),
      phone: r.phone,
    });
  }
  // A block appears on every local day it touches inside the window.
  for (const r of blockRows) {
    const firstDay = localDate(r.startsAt, tz) < from ? from : localDate(r.startsAt, tz);
    const lastInstant = new Date(r.endsAt.getTime() - 1);
    const lastDay = localDate(lastInstant, tz) > to ? to : localDate(lastInstant, tz);
    for (const day of eachLocalDay(firstDay, lastDay)) {
      const dayStart = startOfLocalDay(day, tz);
      const dayEnd = endOfLocalDay(day, tz);
      const startsAt = r.startsAt > dayStart ? r.startsAt : dayStart;
      const endsAt = r.endsAt < dayEnd ? r.endsAt : dayEnd;
      items.push({
        kind: "block",
        id: r.id,
        venueId: r.venueId,
        date: day,
        startsAt,
        endsAt,
        allDay: r.startsAt <= dayStart && r.endsAt >= dayEnd,
        reason: r.reason,
        roomName: r.roomName ?? null,
      });
    }
  }

  const order = { block: 0, party: 1, session: 2 } as const;
  items.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || order[a.kind] - order[b.kind]);
  return items;
}

/** Group schedule items by venue id, keeping the venues' order. */
export function groupByVenue<T extends { venueId: string }>(items: T[], venueIds: string[]): Map<string, T[]> {
  const map = new Map<string, T[]>(venueIds.map((id) => [id, []]));
  for (const it of items) map.get(it.venueId)?.push(it);
  return map;
}

/** Monday of the local week containing `date`. */
export function mondayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}

export type SessionDetail = {
  session: s.Session;
  service: s.Service;
  room: s.Room;
  venue: s.Venue;
  bookings: {
    id: string;
    reference: string;
    status: s.Booking["status"];
    paymentStatus: s.Booking["paymentStatus"];
    places: number;
    lines: s.BookingLine[];
    totalPence: number;
    source: s.Booking["source"];
    notes: string | null;
    customerName: string;
    phone: string | null;
    email: string;
  }[];
  /** Places on pending + confirmed bookings. */
  taken: number;
  /** Places held by live (unexpired) holds. */
  held: number;
};

export async function loadSessionDetail(db: DbOrTx, sessionId: string): Promise<SessionDetail | null> {
  const [row] = await db
    .select({ session: s.sessions, service: s.services, room: s.rooms, venue: s.venues })
    .from(s.sessions)
    .innerJoin(s.services, eq(s.services.id, s.sessions.serviceId))
    .innerJoin(s.rooms, eq(s.rooms.id, s.sessions.roomId))
    .innerJoin(s.venues, eq(s.venues.id, s.sessions.venueId))
    .where(eq(s.sessions.id, sessionId))
    .limit(1);
  if (!row) return null;

  const [bookingRows, [heldRow]] = await Promise.all([
    db
      .select({
        id: s.bookings.id,
        reference: s.bookings.reference,
        status: s.bookings.status,
        paymentStatus: s.bookings.paymentStatus,
        places: s.bookings.places,
        lines: s.bookings.lines,
        totalPence: s.bookings.totalPence,
        source: s.bookings.source,
        notes: s.bookings.notes,
        firstName: s.customers.firstName,
        lastName: s.customers.lastName,
        phone: s.customers.phone,
        email: s.customers.email,
      })
      .from(s.bookings)
      .innerJoin(s.customers, eq(s.customers.id, s.bookings.customerId))
      .where(eq(s.bookings.sessionId, sessionId))
      .orderBy(asc(s.bookings.createdAt)),
    db
      .select({ held: sql<number>`coalesce(sum(${s.holds.places}), 0)` })
      .from(s.holds)
      .where(and(eq(s.holds.sessionId, sessionId), eq(s.holds.status, "active"), gt(s.holds.expiresAt, new Date()))),
  ]);

  const bookings = bookingRows.map((b) => ({
    id: b.id,
    reference: b.reference,
    status: b.status,
    paymentStatus: b.paymentStatus,
    places: b.places,
    lines: b.lines,
    totalPence: b.totalPence,
    source: b.source,
    notes: b.notes,
    customerName: `${b.firstName} ${b.lastName}`.trim(),
    phone: b.phone,
    email: b.email,
  }));
  const taken = bookings.filter((b) => b.status === "pending" || b.status === "confirmed").reduce((n, b) => n + b.places, 0);
  return { ...row, bookings, taken, held: Number(heldRow?.held ?? 0) };
}
