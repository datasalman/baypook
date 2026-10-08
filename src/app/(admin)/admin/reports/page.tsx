import type { Metadata } from "next";
import Link from "next/link";
import { fmtDayShort, fmtLocal, fmtPence, isValidDateStr, startOfLocalDay } from "@/core/time";
import { getAdminContext } from "@/server/venue-scope";
import {
  RANGE_PRESETS,
  isRangePreset,
  noShows,
  outstanding,
  presetRange,
  refundsInRange,
  takingsByDay,
  upcomingSummary,
  type RangePreset,
} from "@/server/reports";
import { Badge, Button, EmptyState, buttonClasses, Field, Input, PageHeader, SectionTitle, SegmentedControl, Stat, cn } from "@/components/ui";
import { todayIn, type SearchParams } from "../_lib/dates";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Reports" };

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const th = "px-3 py-2 text-left text-sm font-semibold text-muted whitespace-nowrap";
const td = "px-3 py-2 whitespace-nowrap tabular-nums";

export default async function ReportsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await getAdminContext();
  const sp = await searchParams;
  const tz = ctx.org.timezone;
  const today = todayIn(tz);

  // Range: explicit from/to wins, else a preset (default this week).
  const fromParam = one(sp.from);
  const toParam = one(sp.to);
  const presetParam = one(sp.preset);
  let preset: RangePreset | "custom" = isRangePreset(presetParam) ? presetParam : "week";
  let { from, to } = presetRange(isRangePreset(presetParam) ? presetParam : "week", today);
  if (fromParam && toParam && isValidDateStr(fromParam) && isValidDateStr(toParam) && !isRangePreset(presetParam)) {
    preset = "custom";
    [from, to] = fromParam <= toParam ? [fromParam, toParam] : [toParam, fromParam];
  }

  const venueIds = ctx.selectedVenues.map((v) => v.id);
  const range = { venueIds, from, to, tz };
  const [takings, upcoming, noShowList, refunds, owed] = await Promise.all([
    takingsByDay(ctx.db, range),
    upcomingSummary(ctx.db, { venueIds }),
    noShows(ctx.db, range),
    refundsInRange(ctx.db, range),
    outstanding(ctx.db, { venueIds }),
  ]);

  const many = ctx.selectedVenues.length > 1;
  const scopeLabel = many ? "All venues" : (ctx.selectedVenues[0]?.name ?? "No venue");
  const rangeLabel =
    from === to
      ? fmtDayShort(startOfLocalDay(from, tz), tz)
      : `${fmtDayShort(startOfLocalDay(from, tz), tz)} to ${fmtDayShort(startOfLocalDay(to, tz), tz)}`;
  const venueParam = ctx.selectedVenueId;
  const exportHref = (kind: string, withDates: boolean) => {
    const q = new URLSearchParams({ kind, venue: venueParam });
    if (withDates) {
      q.set("from", from);
      q.set("to", to);
    }
    return `/admin/reports/export?${q.toString()}`;
  };
  const owedTotal = owed.reduce((n, b) => n + b.owedPence, 0);

  return (
    <>
      <PageHeader title="Reports" subtitle={`${scopeLabel} · ${rangeLabel}`} />

      <SegmentedControl
        aria-label="Date range"
        value={preset}
        options={[
          ...RANGE_PRESETS.map((p) => ({ value: p.value, label: p.label, href: `/admin/reports?preset=${p.value}` })),
        ]}
        className="mb-3"
      />
      <details className="mb-4 rounded-2xl border border-line bg-surface p-3" open={preset === "custom"}>
        <summary className="min-h-11 cursor-pointer py-2 font-semibold">Pick your own dates</summary>
        <form method="get" action="/admin/reports" className="mt-2 grid grid-cols-1 gap-x-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="From" htmlFor="from">
            <Input id="from" name="from" type="date" defaultValue={from} required />
          </Field>
          <Field label="To" htmlFor="to">
            <Input id="to" name="to" type="date" defaultValue={to} required />
          </Field>
          <div className="mb-4">
            <Button type="submit" variant="secondary" block>
              Show
            </Button>
          </div>
        </form>
      </details>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Online" value={fmtPence(takings.totals.onlinePence)} />
        <Stat label="In store" value={fmtPence(takings.totals.inStorePence)} hint="Cash and card machine" />
        <Stat label="Refunds" value={fmtPence(takings.totals.refundsPence)} />
        <Stat label="Net" value={fmtPence(takings.totals.netPence)} />
      </div>

      <SectionTitle aside={<a href={exportHref("takings", true)} download>Download CSV</a>}>Takings by day</SectionTitle>
      {takings.rows.length ? (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
          <table className="w-full border-collapse text-base">
            <thead className="border-b border-line bg-canvas">
              <tr>
                <th scope="col" className={th}>
                  Day
                </th>
                {many ? (
                  <th scope="col" className={th}>
                    Venue
                  </th>
                ) : null}
                <th scope="col" className={cn(th, "text-right")}>
                  Online
                </th>
                <th scope="col" className={cn(th, "text-right")}>
                  In store
                </th>
                <th scope="col" className={cn(th, "text-right")}>
                  Refunds
                </th>
                <th scope="col" className={cn(th, "text-right")}>
                  Net
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {takings.rows.map((r) => (
                <tr key={`${r.date}-${r.venueId}`}>
                  <th scope="row" className={cn(td, "text-left font-medium")}>
                    {fmtDayShort(startOfLocalDay(r.date, tz), tz)}
                  </th>
                  {many ? <td className={td}>{r.venueName}</td> : null}
                  <td className={cn(td, "text-right")}>{fmtPence(r.onlinePence)}</td>
                  <td className={cn(td, "text-right")} title={`Cash ${fmtPence(r.cashPence)}, card machine ${fmtPence(r.cardMachinePence)}`}>
                    {fmtPence(r.inStorePence)}
                  </td>
                  <td className={cn(td, "text-right")}>{r.refundsPence ? `-${fmtPence(r.refundsPence)}` : fmtPence(0)}</td>
                  <td className={cn(td, "text-right font-semibold")}>{fmtPence(r.netPence)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-line bg-canvas font-bold">
              <tr>
                <th scope="row" className={cn(td, "text-left")} colSpan={many ? 2 : 1}>
                  Total
                </th>
                <td className={cn(td, "text-right")}>{fmtPence(takings.totals.onlinePence)}</td>
                <td className={cn(td, "text-right")}>{fmtPence(takings.totals.inStorePence)}</td>
                <td className={cn(td, "text-right")}>
                  {takings.totals.refundsPence ? `-${fmtPence(takings.totals.refundsPence)}` : fmtPence(0)}
                </td>
                <td className={cn(td, "text-right")}>{fmtPence(takings.totals.netPence)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <EmptyState title="No money in or out on these dates" />
      )}

      <SectionTitle aside="Next 14 days, confirmed">Upcoming bookings</SectionTitle>
      {upcoming.length ? (
        <div className="grid gap-3">
          {upcoming.map((v) => (
            <div key={v.venueId} className="rounded-2xl border border-line bg-surface p-4">
              <p className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-lg font-bold">{v.venueName}</span>
                <span className="tabular-nums text-muted">
                  {v.count} {v.count === 1 ? "booking" : "bookings"} · {fmtPence(v.valuePence)}
                </span>
              </p>
              <ul className="mt-2 divide-y divide-line">
                {v.services.map((svc) => (
                  <li key={svc.serviceId} className="flex flex-wrap justify-between gap-2 py-2">
                    <span>{svc.serviceName}</span>
                    <span className="tabular-nums text-muted">
                      {svc.count} {svc.count === 1 ? "booking" : "bookings"}, {svc.places} {svc.places === 1 ? "place" : "places"} ·{" "}
                      {fmtPence(svc.valuePence)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="No confirmed bookings in the next 14 days" />
      )}

      <SectionTitle aside={owed.length ? `${fmtPence(owedTotal)} to collect` : undefined}>Money owed</SectionTitle>
      {owed.length ? (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {owed.map((b) => (
            <li key={b.id}>
              <Link href={`/admin/bookings/${b.id}`} className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-4 py-3 text-ink no-underline hover:bg-canvas">
                <span className="min-w-0">
                  <span className="block font-semibold">
                    {b.customerName} · {b.reference}
                  </span>
                  <span className="block text-sm text-muted">
                    {fmtLocal(b.startsAt, "EEE d MMM, HH:mm", tz)} · {b.serviceName}
                    {many ? ` · ${b.venueName}` : ""}
                  </span>
                </span>
                <Badge status="owed">{fmtPence(b.owedPence)} owed</Badge>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="Nothing owed" />
      )}

      <SectionTitle>Refunds</SectionTitle>
      {refunds.length ? (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {refunds.map((r) => (
            <li key={r.id}>
              <Link href={`/admin/bookings/${r.bookingId}`} className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-4 py-3 text-ink no-underline hover:bg-canvas">
                <span className="min-w-0">
                  <span className="block font-semibold">
                    {fmtPence(r.amountPence)} · {r.reference}
                  </span>
                  <span className="block text-sm text-muted">
                    {fmtLocal(r.createdAt, "EEE d MMM, HH:mm", tz)} · by {r.byName}
                    {many ? ` · ${r.venueName}` : ""}
                    {r.reason ? ` · ${r.reason}` : ""}
                  </span>
                </span>
                {r.status === "succeeded" ? (
                  <Badge tone="green">Refunded</Badge>
                ) : r.status === "pending" ? (
                  <Badge status="pending" />
                ) : (
                  <Badge status="failed" />
                )}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No refunds on these dates" />
      )}

      <SectionTitle>No-shows</SectionTitle>
      {noShowList.length ? (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {noShowList.map((b) => (
            <li key={b.id}>
              <Link href={`/admin/bookings/${b.id}`} className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-4 py-3 text-ink no-underline hover:bg-canvas">
                <span className="min-w-0">
                  <span className="block font-semibold">
                    {b.customerName} · {b.reference}
                  </span>
                  <span className="block text-sm text-muted">
                    {fmtLocal(b.startsAt, "EEE d MMM, HH:mm", tz)} · {b.serviceName} · {b.places} {b.places === 1 ? "place" : "places"}
                    {many ? ` · ${b.venueName}` : ""}
                  </span>
                </span>
                <Badge status="no_show" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No no-shows on these dates" />
      )}

      <SectionTitle>Download</SectionTitle>
      <p className="mb-3 text-muted">CSV files open in Excel, Numbers and Google Sheets. {scopeLabel}.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <a href={exportHref("bookings", true)} download className={buttonClasses({ variant: "secondary" })}>
          Bookings on these dates
        </a>
        <a href={exportHref("bookings", false)} download className={buttonClasses({ variant: "secondary" })}>
          Every booking
        </a>
        <a href={exportHref("customers", false)} download className={buttonClasses({ variant: "secondary" })}>
          Every customer
        </a>
        <a href={exportHref("takings", true)} download className={buttonClasses({ variant: "secondary" })}>
          Takings on these dates
        </a>
      </div>
    </>
  );
}
