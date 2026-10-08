import type { Metadata } from "next";
import Link from "next/link";
import { addDays, eachLocalDay, fmtLocal, fmtTime, startOfLocalDay } from "@/core/time";
import { getAdminContext } from "@/server/venue-scope";
import { Button, DateNav, EmptyState, PageHeader, cn, plural } from "@/components/ui";
import { dateParam, todayIn, type SearchParams } from "../_lib/dates";
import { isFull, loadSchedule, mondayOf, type ScheduleItem } from "../_lib/schedule";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Week" };

function Row({ item, tz, venueName }: { item: ScheduleItem; tz: string; venueName: string | null }) {
  const time = item.kind === "block" && item.allDay ? "All day" : fmtTime(item.startsAt, tz);
  const venue = venueName ? <span className="block truncate text-xs text-muted">{venueName}</span> : null;
  const base = "flex min-h-11 items-start gap-2 rounded-lg px-2 py-1.5 text-sm no-underline";

  if (item.kind === "block") {
    return (
      <li className={cn(base, "bg-[#eceeea] text-[#3d423b]")}>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold tabular-nums">{time} · Blocked</span>
          {item.reason ? <span className="block truncate">{item.reason}</span> : null}
          {venue}
        </span>
      </li>
    );
  }

  if (item.kind === "party") {
    const child = item.birthdayChildFirstName ?? item.parentName;
    return (
      <li>
        <Link href={`/admin/bookings/${item.id}`} className={cn(base, "border-l-4 bg-surface text-ink hover:bg-canvas")} style={{ borderColor: item.colour }}>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold tabular-nums">{time}</span>
            <span className="block truncate font-semibold">{item.serviceName}</span>
            <span className="block truncate text-muted">
              {child} · {plural(item.places, "child", "children")}{item.paymentStatus === "owed" ? " · owed" : ""}
              {item.status === "pending" ? " · pending" : item.status === "no_show" ? " · no-show" : ""}
            </span>
            {venue}
          </span>
        </Link>
      </li>
    );
  }

  const empty = item.taken === 0;
  const full = isFull(item);
  return (
    <li>
      <Link
        href={`/admin/sessions/${item.id}`}
        className={cn(base, "border-l-4 hover:bg-canvas", empty ? "bg-transparent text-muted" : "bg-surface text-ink")}
        style={{ borderColor: empty ? "var(--line)" : item.colour }}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="font-semibold tabular-nums">{time}</span>
            <span className={cn("tabular-nums", full ? "font-bold text-danger" : empty ? "" : "font-semibold")}>
              <span className="sr-only">Places taken </span>
              {item.taken}/{item.capacity}
              {full ? <span className="sr-only"> (full)</span> : null}
            </span>
          </span>
          <span className="block truncate">{item.serviceName}</span>
          {venue}
        </span>
      </Link>
    </li>
  );
}

export default async function WeekPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await getAdminContext();
  const sp = await searchParams;
  const tz = ctx.org.timezone;
  const today = todayIn(tz);
  const thisWeek = mondayOf(today);
  const start = dateParam(sp.start, thisWeek);
  const end = addDays(start, 6);
  const days = eachLocalDay(start, end);

  const venueIds = ctx.selectedVenues.map((v) => v.id);
  const items = await loadSchedule(ctx.db, { venueIds, from: start, to: end, tz });
  const byDay = new Map<string, ScheduleItem[]>(days.map((d) => [d, []]));
  for (const it of items) byDay.get(it.date)?.push(it);
  const venueName = new Map(ctx.selectedVenues.map((v) => [v.id, v.name]));
  const multi = ctx.selectedVenues.length > 1;

  const startLabel = fmtLocal(startOfLocalDay(start, tz), "d MMM", tz);
  const endLabel = fmtLocal(startOfLocalDay(end, tz), "d MMM yyyy", tz);
  const single = ctx.selectedVenues.length === 1 ? ctx.selectedVenues[0] : null;

  if (!ctx.venues.length) {
    return <EmptyState title="No venue yet">Your account is not linked to a venue. Ask the owner to add you to one.</EmptyState>;
  }

  return (
    <div className="lg:relative lg:left-1/2 lg:w-[min(1280px,calc(100vw-2rem))] lg:-translate-x-1/2">
      <div className="mx-auto max-w-3xl lg:max-w-none">
        <PageHeader
          title="Week"
          subtitle={`${single ? single.name : "All venues"} · ${startLabel} to ${endLabel}`}
          actions={
            <Button href={`/admin/bookings/new?${new URLSearchParams({ ...(single ? { venue: single.slug } : {}), date: start < today && today <= end ? today : start }).toString()}`}>
              New booking
            </Button>
          }
        />
        <DateNav mode="week" value={start} today={today} label={`${startLabel} to ${endLabel}`} />
      </div>

      <ol className="flex flex-col gap-4 lg:grid lg:grid-cols-7 lg:gap-2">
        {days.map((day) => {
          const list = byDay.get(day) ?? [];
          const d = startOfLocalDay(day, tz);
          const isToday = day === today;
          const taken = list.reduce((n, i) => n + (i.kind === "session" ? i.taken : 0), 0);
          return (
            <li key={day} className={cn("min-w-0 rounded-2xl border bg-canvas p-2", isToday ? "border-brand-strong" : "border-line")}>
              <Link
                href={`/admin?date=${day}`}
                className="mb-1 flex min-h-11 items-baseline justify-between gap-2 rounded-lg px-1 text-ink no-underline hover:underline"
                aria-label={`Open ${fmtLocal(d, "EEEE d MMMM", tz)}`}
              >
                <span className="font-bold">
                  {fmtLocal(d, "EEE d", tz)}
                  {isToday ? <span className="ml-1 text-sm font-semibold text-brand-strong">Today</span> : null}
                </span>
                {taken ? <span className="text-xs font-semibold text-muted">{taken} booked</span> : null}
              </Link>
              {list.length ? (
                <ul className="flex flex-col gap-1">
                  {list.map((it) => (
                    <Row key={`${it.kind}-${it.id}-${it.date}`} item={it} tz={tz} venueName={multi ? venueName.get(it.venueId) ?? null : null} />
                  ))}
                </ul>
              ) : (
                <p className="px-1 py-2 text-sm text-muted">Nothing on</p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
