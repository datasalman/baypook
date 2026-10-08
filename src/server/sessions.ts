/**
 * Session materialisation against the database. Generates occurrences for a
 * window and reconciles them with the `sessions` table. Safe to call on every
 * availability request: it only writes when something changed.
 */
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";
import { generateOccurrences, occurrenceKey } from "@/core/timetable";
import { endOfLocalDay, startOfLocalDay } from "@/core/time";

/**
 * `keptScheduled` lists the sessions in the window that the rules no longer produce
 * but that stay scheduled because they still have live bookings (pending, confirmed,
 * no-show). It is present only when there are any, so callers can tell the admin
 * exactly which sessions were kept.
 */
export type EnsureSessionsResult = { inserted: number; updated: number; removed: number; keptScheduled?: string[] };

/**
 * Ensure the `sessions` rows for one service between two local dates (inclusive).
 * - inserts missing occurrences
 * - updates capacity/room/length/status of unpinned rows that drifted from the rules
 *   (so a leftover cancelled earlier comes back when the rules produce it again); a
 *   row that would change room while it carries live bookings (pending, confirmed,
 *   no-show) or active holds is pinned where it is instead, so the places already
 *   sold stay in the room the customers were told about
 * - deletes unpinned rows no longer produced by the rules only when nothing
 *   references them. `holds.session_id` and `bookings.session_id` are foreign keys
 *   without cascade, so a row with ANY referencing booking or hold (even a
 *   cancelled booking or an expired hold) is kept instead:
 *   - with live bookings it is pinned as manual and stays scheduled;
 *   - otherwise (only holds, or only finished bookings) it is set cancelled but left
 *     unpinned with its source, so it is restored if the rules produce it again. An
 *     active hold alone is not a reason to keep a session the owner has cancelled:
 *     that hold's checkout then fails
 */
export async function ensureSessions(
  db: DbOrTx,
  service: Pick<s.Service, "id" | "venueId" | "roomId" | "lengthMinutes" | "kind">,
  venue: Pick<s.Venue, "opensAt" | "status">,
  from: string,
  to: string,
  tz: string,
): Promise<EnsureSessionsResult> {
  const result: EnsureSessionsResult = { inserted: 0, updated: 0, removed: 0 };
  if (service.kind !== "session") return result;

  const [rules, exceptions] = await Promise.all([
    db.select().from(s.timetableRules).where(eq(s.timetableRules.serviceId, service.id)),
    db.select().from(s.timetableExceptions).where(eq(s.timetableExceptions.serviceId, service.id)),
  ]);

  const wanted = generateOccurrences({ service, venue, rules, exceptions, from, to, tz });
  const windowStart = startOfLocalDay(from, tz);
  const windowEnd = endOfLocalDay(to, tz);

  const existing = await db
    .select()
    .from(s.sessions)
    .where(and(eq(s.sessions.serviceId, service.id), gte(s.sessions.startsAt, windowStart), lt(s.sessions.startsAt, windowEnd)));
  const existingByKey = new Map(existing.map((row) => [occurrenceKey(row.serviceId, row.startsAt), row]));

  // Sessions in the window that customers are using right now (live bookings or active holds); loaded only when needed.
  let busyCache: Set<string> | null = null;
  const busy = async (): Promise<Set<string>> => (busyCache ??= await liveSessionIds(db, existing.map((r) => r.id)));

  const toInsert: (typeof s.sessions.$inferInsert)[] = [];
  for (const occ of wanted) {
    const key = occurrenceKey(occ.serviceId, occ.startsAt);
    const row = existingByKey.get(key);
    if (!row) {
      toInsert.push({ ...occ, status: "scheduled", pinned: false });
      continue;
    }
    existingByKey.delete(key);
    // Rows that older versions pinned as cancelled "manual" leftovers come back like any other unpinned row.
    const legacyLeftover = row.pinned && row.source === "manual" && row.status === "cancelled";
    if (row.pinned && !legacyLeftover) continue;
    const drift =
      row.capacity !== occ.capacity ||
      row.roomId !== occ.roomId ||
      row.endsAt.getTime() !== occ.endsAt.getTime() ||
      row.status !== "scheduled" ||
      row.source !== occ.source;
    if (drift && row.status === "scheduled" && row.roomId !== occ.roomId && (await busy()).has(row.id)) {
      // Moving would strand the places already sold in the old room: keep it as it is.
      await db.update(s.sessions).set({ pinned: true, updatedAt: new Date() }).where(eq(s.sessions.id, row.id));
      result.updated++;
      continue;
    }
    if (drift) {
      await db
        .update(s.sessions)
        .set({ capacity: occ.capacity, roomId: occ.roomId, endsAt: occ.endsAt, status: "scheduled", source: occ.source, pinned: false, updatedAt: new Date() })
        .where(eq(s.sessions.id, row.id));
      result.updated++;
    }
  }
  if (toInsert.length) {
    await db.insert(s.sessions).values(toInsert).onConflictDoNothing();
    result.inserted += toInsert.length;
  }

  // Leftovers: rows in the window the rules no longer produce.
  const leftoverRows = Array.from(existingByKey.values());
  const liveBooked = leftoverRows.length ? await liveBookingSessionIds(db, leftoverRows.map((r) => r.id)) : new Set<string>();
  const leftovers = leftoverRows.filter((r) => !r.pinned && r.source !== "manual");
  if (leftovers.length) {
    const ids = leftovers.map((r) => r.id);
    const [bookedIds, heldIds] = await Promise.all([
      db.select({ id: s.bookings.sessionId }).from(s.bookings).where(inArray(s.bookings.sessionId, ids)),
      db.select({ id: s.holds.sessionId }).from(s.holds).where(inArray(s.holds.sessionId, ids)),
    ]);
    const referenced = new Set([...bookedIds, ...heldIds].map((r) => r.id).filter((x): x is string => Boolean(x)));
    const removable = ids.filter((id) => !referenced.has(id));
    const keepScheduled = ids.filter((id) => referenced.has(id) && liveBooked.has(id));
    const keepCancelled = leftovers.filter((r) => referenced.has(r.id) && !liveBooked.has(r.id) && r.status !== "cancelled").map((r) => r.id);
    if (removable.length) {
      await db.delete(s.sessions).where(inArray(s.sessions.id, removable));
      result.removed += removable.length;
    }
    if (keepScheduled.length) {
      await db.update(s.sessions).set({ pinned: true, source: "manual", updatedAt: new Date() }).where(inArray(s.sessions.id, keepScheduled));
      result.updated += keepScheduled.length;
    }
    if (keepCancelled.length) {
      // Unpinned and with its source kept: the drift check restores it if the rules produce it again.
      await db.update(s.sessions).set({ status: "cancelled", updatedAt: new Date() }).where(inArray(s.sessions.id, keepCancelled));
      result.updated += keepCancelled.length;
    }
  }
  const kept = leftoverRows.filter((r) => r.status === "scheduled" && liveBooked.has(r.id)).map((r) => r.id);
  if (kept.length) result.keptScheduled = kept;

  return result;
}

/** The ids (of those given) with live bookings (pending, confirmed, no-show) or active holds. */
async function liveSessionIds(db: DbOrTx, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const [booked, held] = await Promise.all([
    db
      .select({ id: s.bookings.sessionId })
      .from(s.bookings)
      .where(and(inArray(s.bookings.sessionId, ids), inArray(s.bookings.status, ["pending", "confirmed", "no_show"]))),
    db
      .select({ id: s.holds.sessionId })
      .from(s.holds)
      .where(and(inArray(s.holds.sessionId, ids), eq(s.holds.status, "active"))),
  ]);
  return new Set([...booked, ...held].map((r) => r.id).filter((x): x is string => Boolean(x)));
}

/** The ids (of those given) with live bookings (pending, confirmed, no-show); holds do not count. */
async function liveBookingSessionIds(db: DbOrTx, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: s.bookings.sessionId })
    .from(s.bookings)
    .where(and(inArray(s.bookings.sessionId, ids), inArray(s.bookings.status, ["pending", "confirmed", "no_show"])));
  return new Set(rows.map((r) => r.id).filter((x): x is string => Boolean(x)));
}

/** Ensure sessions for every session-kind service at a venue in the window. */
export async function ensureVenueSessions(db: DbOrTx, venueId: string, from: string, to: string, tz: string): Promise<void> {
  const [venue] = await db.select().from(s.venues).where(eq(s.venues.id, venueId));
  if (!venue) return;
  const svcs = await db
    .select()
    .from(s.services)
    .where(and(eq(s.services.venueId, venueId), eq(s.services.kind, "session")));
  for (const svc of svcs) {
    if (svc.archivedAt) continue;
    await ensureSessions(db, svc, venue, from, to, tz);
  }
}
