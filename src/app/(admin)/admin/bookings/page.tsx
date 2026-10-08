import type { Metadata } from "next";
import { addDays, endOfLocalDay, fmtDayShort, fmtTime, isValidDateStr, startOfLocalDay } from "@/core/time";
import { listBookings } from "@/server/bookings";
import { getAdminContext } from "@/server/venue-scope";
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { todayIn, type SearchParams } from "../_lib/dates";
import { STATUS_FILTERS, customerName, statusFilter } from "./_lib/labels";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Bookings" };

const PAGE_SIZE = 50;

function one(v: string | string[] | undefined): string {
  return ((Array.isArray(v) ? v[0] : v) ?? "").trim();
}

export default async function BookingsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await getAdminContext();
  const sp = await searchParams;
  const tz = ctx.org.timezone;
  const today = todayIn(tz);

  const q = one(sp.q).slice(0, 100);
  const status = statusFilter(one(sp.status));
  const fromParam = one(sp.from);
  const toParam = one(sp.to);
  const datesGiven = isValidDateStr(fromParam) || isValidDateStr(toParam);
  // A search looks across every date unless dates were chosen.
  const useDates = !q || datesGiven;
  const from = isValidDateStr(fromParam) ? fromParam : today;
  let to = isValidDateStr(toParam) ? toParam : addDays(from, 14);
  if (to < from) to = from;
  const page = Math.max(1, Math.floor(Number(one(sp.page)) || 1));

  const venueIds = ctx.selectedVenues.map((v) => v.id);
  const rows = await listBookings(ctx.db, {
    venueIds,
    from: useDates ? startOfLocalDay(from, tz) : undefined,
    to: useDates ? endOfLocalDay(to, tz) : undefined,
    status: status === "all" ? undefined : status,
    search: q || undefined,
    limit: PAGE_SIZE + 1,
    offset: (page - 1) * PAGE_SIZE,
    order: useDates ? "asc" : "desc",
  });
  const hasNext = rows.length > PAGE_SIZE;
  const list = rows.slice(0, PAGE_SIZE);
  const showVenue = ctx.selectedVenues.length > 1;
  const single = ctx.selectedVenues.length === 1 ? ctx.selectedVenues[0] : null;

  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (status !== "all") params.set("status", status);
    if (datesGiven) {
      params.set("from", from);
      params.set("to", to);
    }
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `/admin/bookings?${qs}` : "/admin/bookings";
  };

  const newHref = `/admin/bookings/new${single ? `?venue=${encodeURIComponent(single.slug)}` : ""}`;

  return (
    <>
      <PageHeader
        title="Bookings"
        subtitle={single ? single.name : "All venues"}
        actions={
          <Button href={newHref} size="lg">
            New booking
          </Button>
        }
      />

      <form method="get" action="/admin/bookings" className="mb-4 rounded-2xl border border-line bg-surface p-3" role="search">
        <Field label="Search" htmlFor="q" hint="Reference, name, email or phone. With no dates, searches every date.">
          <Input id="q" name="q" type="search" defaultValue={q} autoComplete="off" />
        </Field>
        <div className="grid grid-cols-2 gap-x-3">
          <Field label="From" htmlFor="from" hint="Empty: today">
            <Input id="from" name="from" type="date" defaultValue={datesGiven ? from : ""} />
          </Field>
          <Field label="To" htmlFor="to" hint="Empty: two weeks on">
            <Input id="to" name="to" type="date" defaultValue={datesGiven ? to : ""} />
          </Field>
        </div>
        <Field label="Status" htmlFor="status">
          <Select id="status" name="status" defaultValue={status} options={STATUS_FILTERS.map((f) => ({ value: f.value, label: f.label }))} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit">Show bookings</Button>
          {q || datesGiven || status !== "all" ? (
            <Button href="/admin/bookings" variant="secondary">
              Clear
            </Button>
          ) : null}
        </div>
      </form>

      <p className="mb-2 text-sm text-muted" aria-live="polite">
        {useDates
          ? `${fmtDayShort(startOfLocalDay(from, tz), tz)} to ${fmtDayShort(startOfLocalDay(to, tz), tz)}`
          : "Searching every date, newest first"}
        {list.length ? ` · ${(page - 1) * PAGE_SIZE + 1}–${(page - 1) * PAGE_SIZE + list.length}` : ""}
      </p>

      {list.length ? (
        <ul className="flex flex-col gap-2">
          {list.map(({ booking: b, customer, service, venue }) => (
            <Card key={b.id} as="li" href={`/admin/bookings/${b.id}`} accent={service.colour} tone={b.status === "cancelled" ? "muted" : "default"}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-base font-bold text-ink">
                    <span className="tabular-nums">
                      {fmtDayShort(b.startsAt, tz)} {fmtTime(b.startsAt, tz)}
                    </span>{" "}
                    <span className="font-semibold">{service.name}</span>
                  </p>
                  <p className="text-base">
                    {customerName(customer)} · {b.places} {service.kind === "slot" ? "children" : b.places === 1 ? "place" : "places"}
                  </p>
                  <p className="text-sm text-muted">
                    {b.reference}
                    {showVenue ? ` · ${venue.name}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Badge status={b.status} />
                  {b.status !== "cancelled" || b.paidPence > 0 ? <Badge status={b.paymentStatus} /> : null}
                </div>
              </div>
            </Card>
          ))}
        </ul>
      ) : (
        <EmptyState title="No bookings found" action={<Button href={newHref}>New booking</Button>}>
          {q ? "Try part of the name, the phone number or the reference." : "Nothing booked in these dates."}
        </EmptyState>
      )}

      {page > 1 || hasNext ? (
        <nav aria-label="Pages" className="mt-4 flex justify-between gap-2">
          {page > 1 ? (
            <Button href={pageHref(page - 1)} variant="secondary">
              ‹ Previous
            </Button>
          ) : (
            <span />
          )}
          {hasNext ? (
            <Button href={pageHref(page + 1)} variant="secondary">
              Next ›
            </Button>
          ) : null}
        </nav>
      ) : null}
    </>
  );
}
