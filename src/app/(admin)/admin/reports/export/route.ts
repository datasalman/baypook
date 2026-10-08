/**
 * CSV export: GET /admin/reports/export?kind=takings|bookings|customers&venue=<id>|all&from=&to=
 * Signed-in users only, scoped to the venues they can see. UTF-8 with BOM, RFC 4180.
 * Takings and customers need an owner or a manager of every venue in scope; staff
 * get the bookings export without the email and phone columns.
 */
import { isValidDateStr, localDate } from "@/core/time";
import { getDb } from "@/db";
import { requireUser, visibleVenueIds } from "@/server/auth";
import { getOrganisation, listVenues } from "@/server/org";
import { CSV_BOM, bookingsCsv, canSeeMoneyAndContacts, customersCsv, takingsByDay, takingsCsvRows, toCsv } from "@/server/reports";

export const dynamic = "force-dynamic";

type Kind = "takings" | "bookings" | "customers";

function bad(message: string, status = 400): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const user = await requireUser(`/admin/reports`);
  const db = await getDb();
  const [org, all] = await Promise.all([getOrganisation(db), listVenues(db)]);
  const tz = org.timezone;

  const kindParam = url.searchParams.get("kind") ?? "bookings";
  if (kindParam !== "takings" && kindParam !== "bookings" && kindParam !== "customers") return bad("Unknown export.");
  const kind: Kind = kindParam;

  const visible = visibleVenueIds(
    user,
    all.map((v) => v.id),
  );
  const venueParam = url.searchParams.get("venue") ?? "all";
  let venueIds: string[];
  if (venueParam === "all") venueIds = visible;
  else if (visible.includes(venueParam)) venueIds = [venueParam];
  else return bad("You do not have access to that venue.", 403);

  // Contact details and money leave the building only with an owner or a manager of every venue in scope.
  const full = canSeeMoneyAndContacts(user, venueIds);
  if (kind !== "bookings" && !full) return bad("Only owners and managers can export this.", 403);

  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  const from = fromRaw && isValidDateStr(fromRaw) ? fromRaw : null;
  const to = toRaw && isValidDateStr(toRaw) ? toRaw : null;

  let rows: string[][];
  if (kind === "takings") {
    const today = localDate(new Date(), tz);
    const report = await takingsByDay(db, { venueIds, from: from ?? today, to: to ?? from ?? today, tz });
    rows = takingsCsvRows(report);
  } else if (kind === "bookings") {
    rows = await bookingsCsv(db, { venueIds, tz, from, to, includeContact: full });
  } else {
    rows = await customersCsv(db, { venueIds, tz, allCustomers: user.isOwner && venueParam === "all" });
  }

  const slug = venueParam === "all" ? "all-venues" : (all.find((v) => v.id === venueParam)?.slug ?? "venue");
  const datePart = from && to && kind !== "customers" ? `${from}_to_${to}` : localDate(new Date(), tz);
  const filename = `${kind}-${slug}-${datePart}.csv`;

  return new Response(CSV_BOM + toCsv(rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
