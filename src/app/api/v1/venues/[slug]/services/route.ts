import { getDb } from "@/db";
import { json, preflight, withApi } from "@/lib/api";
import { listServicesForVenue } from "@/server/catalogue";
import { requireVenue, serviceJson } from "../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const OPTIONS = preflight;

type Ctx = { params: Promise<{ slug: string }> };

export const GET = withApi<Ctx>(async (_req, ctx) => {
  const { slug } = await ctx.params;
  const db = await getDb();
  const venue = await requireVenue(db, slug);
  const services = await listServicesForVenue(db, venue.id, { onlineOnly: true });
  return json({ services: services.map(serviceJson) });
});
