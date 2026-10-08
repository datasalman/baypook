import { getDb } from "@/db";
import { DB_RATE_LIMITS, json, preflight, readJson, withApi } from "@/lib/api";
import { quoteBodySchema } from "@/lib/validation";
import { quoteForService } from "@/server/quote";
import { requireOnlineService, requireVenue } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const OPTIONS = preflight;

export const POST = withApi(async (req) => {
  const body = quoteBodySchema.parse(await readJson(req));
  const db = await getDb();
  const venue = await requireVenue(db, body.venue);
  const service = await requireOnlineService(db, venue, body.service);
  const quote = quoteForService(null, { service, venue, lines: body.lines, addOns: body.addOns });
  return json({ quote });
}, { dbRateLimit: DB_RATE_LIMITS.quote });
