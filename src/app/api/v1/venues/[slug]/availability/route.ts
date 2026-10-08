import { getDb } from "@/db";
import { ApiError, json, preflight, withApi } from "@/lib/api";
import { availabilityQuerySchema, queryObject } from "@/lib/validation";
import { DEFAULT_TZ, eachLocalDay, localDate } from "@/core/time";
import type { NotBookableReason } from "@/core/availability";
import { getSessionAvailability, getSlotStarts } from "@/server/availability";
import { getOrganisation } from "@/server/org";
import { requireOnlineService, requireVenue } from "../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const OPTIONS = preflight;

const MAX_DAYS = 62;

type ApiReason = "full" | "cutoff" | "lead_time" | "blocked" | "room_busy" | "past" | "cancelled";

/** The API's reasons (docs/API.md); a closed venue reads as "blocked". */
function apiReason(r: NotBookableReason | null): ApiReason | null {
  if (r === null) return null;
  return r === "closed" ? "blocked" : r;
}

type Ctx = { params: Promise<{ slug: string }> };

export const GET = withApi<Ctx>(async (req, ctx) => {
  const { slug } = await ctx.params;
  const q = availabilityQuerySchema.parse(queryObject(new URL(req.url)));
  const from = q.from;
  const to = q.to ?? q.from;
  if (to < from) throw new ApiError("INVALID", "to must be on or after from.");
  const days = eachLocalDay(from, to);
  if (days.length > MAX_DAYS) throw new ApiError("INVALID", `Ask for at most ${MAX_DAYS} days at a time.`);

  const db = await getDb();
  const venue = await requireVenue(db, slug);
  const service = await requireOnlineService(db, venue, q.service);
  const org = await getOrganisation(db);
  const tz = org.timezone || DEFAULT_TZ;
  const now = new Date();

  if (service.kind === "session") {
    const all = await getSessionAvailability(db, { venue, service, from, to, now, tz });
    const future = all.filter((a) => a.startsAt.getTime() > now.getTime());
    return json({
      kind: "session",
      days: days.map((date) => ({
        date,
        sessions: future
          .filter((a) => localDate(a.startsAt, tz) === date)
          .map((a) => ({
            id: a.sessionId,
            startsAt: a.startsAt.toISOString(),
            endsAt: a.endsAt.toISOString(),
            capacity: a.capacity,
            // What can still be booked: 0 when the time is not bookable for any reason.
            remaining: a.bookable ? a.remaining : 0,
            bookable: a.bookable,
            reason: apiReason(a.reason),
          })),
      })),
    });
  }

  const out: { date: string; starts: { startsAt: string; endsAt: string }[] }[] = [];
  for (const date of days) {
    const starts = await getSlotStarts(db, { venue, service, day: date, extraMinutes: q.extraMinutes, now, tz });
    out.push({
      date,
      starts: starts.filter((x) => x.bookable).map((x) => ({ startsAt: x.startsAt.toISOString(), endsAt: x.endsAt.toISOString() })),
    });
  }
  return json({ kind: "slot", days: out });
});
