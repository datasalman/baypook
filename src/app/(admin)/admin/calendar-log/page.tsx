import type { Metadata } from "next";
import Link from "next/link";
import { inArray } from "drizzle-orm";
import * as s from "@/db/schema";
import { fmtLocal } from "@/core/time";
import { isDemo } from "@/lib/env";
import { listCalendarLog } from "@/server/calendar";
import { getAdminContext } from "@/server/venue-scope";
import { Badge, Banner, Button, EmptyState, PageHeader } from "@/components/ui";
import { retryCalendar } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Calendar log" };

const ACTION_LABEL: Record<s.CalendarLogRow["action"], string> = {
  create: "Added",
  update: "Updated",
  delete: "Removed",
};

const SHOW = 200;

export default async function CalendarLogPage() {
  const ctx = await getAdminContext();
  const tz = ctx.org.timezone;
  const venueIds = ctx.user.isOwner && ctx.selectedVenueId === "all" ? null : ctx.selectedVenues.map((v) => v.id);
  const rows = await listCalendarLog(ctx.db, { venueIds, limit: SHOW });

  const bookingIds = [...new Set(rows.map((r) => r.bookingId).filter((x): x is string => Boolean(x)))];
  const refs = bookingIds.length
    ? await ctx.db.select({ id: s.bookings.id, reference: s.bookings.reference }).from(s.bookings).where(inArray(s.bookings.id, bookingIds))
    : [];
  const refById = new Map(refs.map((r) => [r.id, r.reference]));
  const venueName = new Map(ctx.venues.map((v) => [v.id, v.name]));

  return (
    <>
      <PageHeader title="Calendar log" subtitle="Bookings pushed to each venue's Google Calendar, newest first" />
      {isDemo() ? (
        <Banner tone="info" className="mb-4">
          Demo mode: nothing was pushed to Google. In live mode this page lists every change sent to the calendar.
        </Banner>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState title="Nothing pushed yet">Confirmed bookings, changes and cancellations show up here.</EmptyState>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {rows.map((r) => {
            const ref = r.bookingId ? refById.get(r.bookingId) : undefined;
            return (
              <li key={r.id} className="flex flex-col gap-1 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">
                    {ACTION_LABEL[r.action]}
                    {ref && r.bookingId ? (
                      <>
                        {" · "}
                        <Link href={`/admin/bookings/${r.bookingId}`}>{ref}</Link>
                      </>
                    ) : null}
                  </span>
                  {r.status === "ok" ? <Badge tone="green">Done</Badge> : <Badge status={r.status} />}
                </div>
                <p className="text-sm text-muted">
                  {fmtLocal(r.createdAt, "EEE d MMM, HH:mm", tz)}
                  {r.venueId ? ` · ${venueName.get(r.venueId) ?? ""}` : ""}
                  {r.provider === "google" ? " · Google" : ""}
                </p>
                {r.providerEventId ? (
                  <p className="break-all text-sm">
                    Event id: <span className="font-mono">{r.providerEventId}</span>
                  </p>
                ) : null}
                {r.error ? <p className="break-words text-sm font-semibold text-danger">{r.error}</p> : null}
                {r.status === "failed" && r.bookingId ? (
                  <form action={retryCalendar} className="mt-1">
                    <input type="hidden" name="id" value={r.id} />
                    <Button type="submit" variant="secondary" size="sm">
                      Try again
                    </Button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {rows.length === SHOW ? <p className="mt-3 text-center text-sm text-muted">Showing the newest {SHOW}.</p> : null}
    </>
  );
}
