import { getDb } from "@/db";
import { ApiError, json, preflight, readJson, withApi } from "@/lib/api";
import { holdBodySchema } from "@/lib/validation";
import { DEFAULT_TZ } from "@/core/time";
import { createHold } from "@/server/holds";
import { getOrganisation } from "@/server/org";
import { onlineBookable, requireOnlineService, requireVenue } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const OPTIONS = preflight;

export const POST = withApi(async (req) => {
  const body = holdBodySchema.parse(await readJson(req));
  const db = await getDb();
  const venue = await requireVenue(db, body.venue);
  if (!onlineBookable(venue)) throw new ApiError("UNAVAILABLE", "This venue cannot be booked online right now. Please call or message us.");
  const service = await requireOnlineService(db, venue, body.service);
  const org = await getOrganisation(db);
  const { hold, quote } = await createHold(db, {
    venue,
    service,
    holdMinutes: org.holdMinutes,
    sessionId: body.sessionId ?? null,
    startsAt: body.startsAt ? new Date(body.startsAt) : null,
    lines: body.lines,
    addOns: body.addOns,
    tz: org.timezone || DEFAULT_TZ,
  });
  return json({
    hold: {
      id: hold.id,
      expiresAt: hold.expiresAt.toISOString(),
      startsAt: hold.startsAt.toISOString(),
      endsAt: hold.endsAt.toISOString(),
    },
    quote,
  });
});
