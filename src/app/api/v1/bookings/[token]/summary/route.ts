import { getDb } from "@/db";
import { ApiError, json, preflight, withApi } from "@/lib/api";
import { getBookingSummaryByToken } from "@/server/bookings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const OPTIONS = preflight;

type Ctx = { params: Promise<{ token: string }> };

export const GET = withApi<Ctx>(async (_req, ctx) => {
  const { token } = await ctx.params;
  const db = await getDb();
  const summary = await getBookingSummaryByToken(db, token);
  if (!summary) throw new ApiError("NOT_FOUND", "We could not find that booking.");
  return json(summary);
});
