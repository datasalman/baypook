/**
 * Session materialisation against the database. Generates occurrences for a
 * window and reconciles them with the `sessions` table. Safe to call on every
 * availability request: it only writes when something changed, and it only reads
 * the bookings and holds of the window when a row drifted or is left over.
 */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";
import { generateOccurrences, occurrenceKey } from "@/core/timetable";
import { endOfLocalDay, startOfLocalDay } from "@/core/time";

/** A produced session whose capacity was kept above what the rules ask for, because more places are already booked. */
export type HeldAboveRules = { id: string; startsAt: Date; wanted: number; capacity: number };

/**
 * `keptScheduled` lists the sessions in the window that the rules no longer produce
 * but that stay scheduled because they still have live bookings (pending, confirmed,
 * no-show). They are closed to new bookings (capacity = places already booked). It is
 * present only when there are any, so callers can tell the admin exactly which
 * sessions were kept.
 * `heldAboveRules` lists produced sessions whose capacity stays above the rules'
 * (a lowered rule or a capacity exception) because more places are already booked.
 */
export type EnsureSessionsResult = {
  inserted: number;
  updated: number;
  removed: number;
  keptScheduled?: string[];
  heldAboveRules?: HeldAboveRules[];
};

/** Bookings and holds that refer to the sessions of the window. */
type Usage = {
  /** Places on pending and confirmed bookings (what availability counts as taken). */
  places: Map<string, number>;
  /** Sessions with live bookings: pending, confirmed or no-show. */
  live: Set<string>;
  /** Sessions with live bookings or active holds: customers are using them right now. */
  busy: Set<string>;
  /** Sessions with ANY booking or hold row (foreign keys without cascade). */
  referenced: Set<string>;
};

const LIVE_STATUSES = new Set<s.Booking["status"]>(["pending", "confirmed", "no_show"]);

/**
 * Ensure the `sessions` rows for one service between two local dates (inclusive).
 * - inserts missing occurrences
 * - updates capacity/room/length/status of unpinned rows that drifted from the rules
 *   (so a leftover cancelled earlier comes back when the rules produce it again). The
 *   capacity never drops below the places already booked on the row. A row that
 *   would change room while it carries live bookings (pending, confirmed, no-show) or
 *   active holds is pinned where it is instead, so the places already sold stay in the
 *   room the customers were told about
 * - a pinned `manual` row (a leftover kept for its bookings) that the rules produce
 *   again is unpinned and gets the rules' capacity back when it is in the same room;
 *   in another room it keeps its room and stays pinned, but sells again
 * - handles rows the rules no longer produce (a cancelled day or time, a deleted rule,
 *   a closed venue), pinned or not. `holds.session_id` and `bookings.session_id` are
 *   foreign keys without cascade, so:
 *   - a row nothing refers to is deleted;
 *   - a scheduled row with live bookings is kept scheduled, pinned as `manual`, and
 *     closed to new bookings: its capacity becomes the places already booked, so it
 *     shows as full (a cancelled one with live bookings is left as it is);
 *   - otherwise (only holds, or only finished bookings) it is set cancelled and
 *     unpinned with its source, so it is restored if the rules produce it again. An
 *     active hold alone is not a reason to keep a session the owner has cancelled:
 *     that hold's checkout then fails. An admin's own cancellation stays as it is.
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

  // Loaded only when a row drifted or is left over, so a quiet window costs no extra reads.
  let usageCache: Usage | null = null;
  const usage = async (): Promise<Usage> => (usageCache ??= await loadUsage(db, existing.map((r) => r.id)));
  const heldAbove: HeldAboveRules[] = [];

  const toInsert: (typeof s.sessions.$inferInsert)[] = [];
  for (const occ of wanted) {
    const key = occurrenceKey(occ.serviceId, occ.startsAt);
    const row = existingByKey.get(key);
    if (!row) {
      toInsert.push({ ...occ, status: "scheduled", pinned: false });
      continue;
    }
    existingByKey.delete(key);

    const keptLeftover = row.pinned && row.source === "manual";
    // An admin's own edit (capacity, cancellation, room kept for its bookings) is left alone.
    if (row.pinned && !keptLeftover) continue;

    // Never below the places already booked.
    let capacity = occ.capacity;
    if (row.capacity !== occ.capacity) {
      capacity = Math.max(occ.capacity, (await usage()).places.get(row.id) ?? 0);
      if (capacity > occ.capacity) heldAbove.push({ id: row.id, startsAt: row.startsAt, wanted: occ.capacity, capacity });
    }

    if (keptLeftover && row.status === "scheduled" && row.roomId !== occ.roomId) {
      // Produced again, but in another room while its bookings are in this one: sell it again where it is.
      await db
        .update(s.sessions)
        .set({ capacity, endsAt: occ.endsAt, source: occ.source, updatedAt: new Date() })
        .where(eq(s.sessions.id, row.id));
      result.updated++;
      continue;
    }

    const drift =
      keptLeftover ||
      row.capacity !== capacity ||
      row.roomId !== occ.roomId ||
      row.endsAt.getTime() !== occ.endsAt.getTime() ||
      row.status !== "scheduled" ||
      row.source !== occ.source;
    if (!drift) continue;
    if (row.status === "scheduled" && row.roomId !== occ.roomId && (await usage()).busy.has(row.id)) {
      // Moving would strand the places already sold in the old room: keep it as it is.
      await db.update(s.sessions).set({ pinned: true, updatedAt: new Date() }).where(eq(s.sessions.id, row.id));
      result.updated++;
      continue;
    }
    await db
      .update(s.sessions)
      .set({ capacity, roomId: occ.roomId, endsAt: occ.endsAt, status: "scheduled", source: occ.source, pinned: false, updatedAt: new Date() })
      .where(eq(s.sessions.id, row.id));
    result.updated++;
  }
  if (toInsert.length) {
    await db.insert(s.sessions).values(toInsert).onConflictDoNothing();
    result.inserted += toInsert.length;
  }

  // Leftovers: rows in the window the rules no longer produce, pinned or not.
  const leftovers = Array.from(existingByKey.values());
  const kept: string[] = [];
  if (leftovers.length) {
    const u = await usage();
    const removable: string[] = [];
    for (const r of leftovers) {
      if (!u.referenced.has(r.id)) {
        removable.push(r.id);
        continue;
      }
      if (u.live.has(r.id)) {
        // Already not selling (an admin cancelled it with its bookings): leave it as it is.
        if (r.status === "cancelled") continue;
        // Kept for its bookings and closed to new ones: as many places as are booked.
        const patch: Partial<typeof s.sessions.$inferInsert> = {};
        if (!r.pinned) patch.pinned = true;
        if (r.source !== "manual") patch.source = "manual";
        const places = u.places.get(r.id) ?? 0;
        if (r.capacity !== places) patch.capacity = places;
        kept.push(r.id);
        if (Object.keys(patch).length) {
          await db.update(s.sessions).set({ ...patch, updatedAt: new Date() }).where(eq(s.sessions.id, r.id));
          result.updated++;
        }
        continue;
      }
      // Only holds or finished bookings refer to it. A cancelled row stays as it is
      // (an admin's own cancellation stays pinned), except a kept leftover, which is let go.
      if (r.status === "cancelled" && !(r.pinned && r.source === "manual")) continue;
      // Unpinned with its source kept: the drift check restores it if the rules produce it again.
      await db.update(s.sessions).set({ status: "cancelled", pinned: false, updatedAt: new Date() }).where(eq(s.sessions.id, r.id));
      result.updated++;
    }
    if (removable.length) {
      await db.delete(s.sessions).where(inArray(s.sessions.id, removable));
      result.removed += removable.length;
    }
  }
  if (kept.length) result.keptScheduled = kept;
  if (heldAbove.length) result.heldAboveRules = heldAbove;

  return result;
}

async function loadUsage(db: DbOrTx, ids: string[]): Promise<Usage> {
  const out: Usage = { places: new Map(), live: new Set(), busy: new Set(), referenced: new Set() };
  if (ids.length === 0) return out;
  const [booked, held] = await Promise.all([
    db
      .select({ id: s.bookings.sessionId, status: s.bookings.status, places: sql<number>`coalesce(sum(${s.bookings.places}), 0)` })
      .from(s.bookings)
      .where(inArray(s.bookings.sessionId, ids))
      .groupBy(s.bookings.sessionId, s.bookings.status),
    db
      .selectDistinct({ id: s.holds.sessionId, status: s.holds.status })
      .from(s.holds)
      .where(inArray(s.holds.sessionId, ids)),
  ]);
  for (const b of booked) {
    if (!b.id) continue;
    out.referenced.add(b.id);
    if (LIVE_STATUSES.has(b.status)) {
      out.live.add(b.id);
      out.busy.add(b.id);
    }
    if (b.status === "pending" || b.status === "confirmed") out.places.set(b.id, (out.places.get(b.id) ?? 0) + Number(b.places));
  }
  for (const h of held) {
    if (!h.id) continue;
    out.referenced.add(h.id);
    if (h.status === "active") out.busy.add(h.id);
  }
  return out;
}

/** Ensure sessions for every session-kind service at a venue in the window. */
export async function ensureVenueSessions(db: DbOrTx, venueId: string, from: string, to: string, tz: string): Promise<EnsureSessionsResult> {
  const total: EnsureSessionsResult = { inserted: 0, updated: 0, removed: 0 };
  const [venue] = await db.select().from(s.venues).where(eq(s.venues.id, venueId));
  if (!venue) return total;
  const svcs = await db
    .select()
    .from(s.services)
    .where(and(eq(s.services.venueId, venueId), eq(s.services.kind, "session")));
  for (const svc of svcs) {
    if (svc.archivedAt) continue;
    const r = await ensureSessions(db, svc, venue, from, to, tz);
    total.inserted += r.inserted;
    total.updated += r.updated;
    total.removed += r.removed;
    if (r.keptScheduled) (total.keptScheduled ??= []).push(...r.keptScheduled);
    if (r.heldAboveRules) (total.heldAboveRules ??= []).push(...r.heldAboveRules);
  }
  return total;
}
