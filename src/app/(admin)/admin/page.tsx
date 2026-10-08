import { and, asc, eq, gte, lt } from "drizzle-orm";
import { getDb } from "@/db";
import * as s from "@/db/schema";
import { addDays, endOfLocalDay, fmtDayLong, fmtTime, localDate, startOfLocalDay } from "@/core/time";
import { getOrganisation, listVenues } from "@/server/org";
import { ensureVenueSessions } from "@/server/sessions";

export const dynamic = "force-dynamic";

/** Stage 0 placeholder admin: lists venues and tomorrow's sessions from the seed. */
export default async function AdminHome() {
  const db = await getDb();
  const org = await getOrganisation(db);
  const venues = await listVenues(db);
  const tomorrow = addDays(localDate(new Date(), org.timezone), 1);
  const from = startOfLocalDay(tomorrow, org.timezone);
  const to = endOfLocalDay(tomorrow, org.timezone);

  const perVenue = [];
  for (const v of venues) {
    await ensureVenueSessions(db, v.id, tomorrow, tomorrow, org.timezone);
    const rows = await db
      .select({ startsAt: s.sessions.startsAt, endsAt: s.sessions.endsAt, capacity: s.sessions.capacity, service: s.services.name, room: s.rooms.name })
      .from(s.sessions)
      .innerJoin(s.services, eq(s.services.id, s.sessions.serviceId))
      .innerJoin(s.rooms, eq(s.rooms.id, s.sessions.roomId))
      .where(and(eq(s.sessions.venueId, v.id), gte(s.sessions.startsAt, from), lt(s.sessions.startsAt, to), eq(s.sessions.status, "scheduled")))
      .orderBy(asc(s.sessions.startsAt));
    perVenue.push({ venue: v, rows });
  }

  return (
    <main className="mx-auto max-w-2xl p-4">
      <h1 className="text-2xl font-semibold">{org.name} admin</h1>
      <p className="text-sm opacity-70">Tomorrow, {fmtDayLong(from, org.timezone)}</p>
      {perVenue.map(({ venue, rows }) => (
        <section key={venue.id} className="mt-6">
          <h2 className="text-lg font-semibold">
            {venue.name} <span className="text-sm font-normal opacity-60">({venue.status})</span>
          </h2>
          {rows.length === 0 ? (
            <p className="text-sm opacity-70">No sessions tomorrow.</p>
          ) : (
            <ul className="mt-2 divide-y rounded-lg border">
              {rows.map((r) => (
                <li key={r.startsAt.toISOString() + r.service} className="flex items-center justify-between p-3">
                  <span>
                    {fmtTime(r.startsAt, org.timezone)} to {fmtTime(r.endsAt, org.timezone)} {r.service}
                  </span>
                  <span className="text-sm opacity-70">
                    {r.room}, {r.capacity} places
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </main>
  );
}
