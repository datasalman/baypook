import type { Metadata } from "next";
import { fmtDayLong, startOfLocalDay, weekdayKey, zonedDateTime } from "@/core/time";
import type * as s from "@/db/schema";
import { getAdminContext } from "@/server/venue-scope";
import { Button, DateNav, EmptyState, PageHeader, SectionTitle } from "@/components/ui";
import { ScheduleList } from "@/components/admin/ScheduleCards";
import { dateParam, relativeDayName, todayIn, type SearchParams } from "./_lib/dates";
import { groupByVenue, loadSchedule, type ScheduleItem } from "./_lib/schedule";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Today" };

function closedNote(venue: s.Venue, date: string, tz: string): string {
  const noon = zonedDateTime(date, "12:00", tz);
  if (venue.opensAt && venue.opensAt > noon) {
    return `${venue.name} opens on ${fmtDayLong(venue.opensAt, tz)}.`;
  }
  if (!venue.openingHours[weekdayKey(noon, tz)]) return `${venue.name} is closed on this day.`;
  return "No sessions, parties or blocked time.";
}

function summary(items: ScheduleItem[]): string {
  const sessions = items.filter((i) => i.kind === "session");
  const parties = items.filter((i) => i.kind === "party");
  const places = sessions.reduce((n, i) => n + (i.kind === "session" ? i.taken : 0), 0);
  const parts = [`${places} ${places === 1 ? "place" : "places"} booked`];
  if (parties.length) parts.push(`${parties.length} ${parties.length === 1 ? "party" : "parties"}`);
  return parts.join(" · ");
}

export default async function TodayPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await getAdminContext();
  const sp = await searchParams;
  const tz = ctx.org.timezone;
  const today = todayIn(tz);
  const date = dateParam(sp.date, today);
  const label = fmtDayLong(startOfLocalDay(date, tz), tz);
  const rel = relativeDayName(date, today);

  const venueIds = ctx.selectedVenues.map((v) => v.id);
  const items = await loadSchedule(ctx.db, { venueIds, from: date, to: date, tz });
  const grouped = groupByVenue(items, venueIds);
  const single = ctx.selectedVenues.length === 1 ? ctx.selectedVenues[0] : null;

  const newBookingHref = `/admin/bookings/new?${new URLSearchParams({ ...(single ? { venue: single.slug } : {}), date }).toString()}`;

  if (!ctx.venues.length) {
    return (
      <EmptyState title="No venue yet">
        Your account is not linked to a venue. Ask the owner to add you to one in Users and invites.
      </EmptyState>
    );
  }

  return (
    <>
      <PageHeader
        title={rel ?? label}
        subtitle={rel ? label : single ? single.name : "All venues"}
        actions={
          <Button href={newBookingHref} size="lg">
            New booking
          </Button>
        }
      />
      <DateNav value={date} today={today} label={rel ? `${rel}, ${label}` : label} />

      {ctx.selectedVenues.map((venue) => {
        const list = grouped.get(venue.id) ?? [];
        const rooms = new Set(list.flatMap((i) => (i.kind === "block" ? [] : [i.roomName])));
        return (
          <section key={venue.id} aria-labelledby={`venue-${venue.id}`} className="mb-6">
            {ctx.selectedVenues.length > 1 || !single ? (
              <SectionTitle aside={list.length ? summary(list) : undefined}>
                <span id={`venue-${venue.id}`}>{venue.name}</span>
              </SectionTitle>
            ) : (
              <p id={`venue-${venue.id}`} className="mb-2 text-sm font-semibold text-muted">
                {list.length ? summary(list) : venue.name}
              </p>
            )}
            {list.length ? (
              <ScheduleList items={list} tz={tz} showRoom={rooms.size > 1} />
            ) : (
              <EmptyState title="Nothing on">{closedNote(venue, date, tz)}</EmptyState>
            )}
          </section>
        );
      })}
    </>
  );
}
