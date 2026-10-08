import { getDb } from "@/db";
import { json, preflight, withApi } from "@/lib/api";
import { getOrganisation, listVenues } from "@/server/org";
import { organisationJson, venueJson } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const OPTIONS = preflight;

export const GET = withApi(async () => {
  const db = await getDb();
  const [org, venues] = await Promise.all([getOrganisation(db), listVenues(db)]);
  return json({ venues: venues.map((v) => venueJson(v, org.timezone)), organisation: organisationJson(org) });
});
