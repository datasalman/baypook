import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { fmtDayLong, fmtTime, localDate, minutesBetween, startOfLocalDay } from "@/core/time";
import { canAccessVenue } from "@/server/auth";
import { getBookingDetail } from "@/server/bookings";
import { getService } from "@/server/catalogue";
import { getAdminContext } from "@/server/venue-scope";
import { Badge, Banner, Button, DateNav, EmptyState, PageHeader } from "@/components/ui";
import { withFlash } from "@/components/ui/flash";
import { cn } from "@/components/ui/cn";
import { dateParam, todayIn, type SearchParams } from "../../../_lib/dates";
import { adminSessionChoices, adminSlotChoices, STAFF_REASON } from "../../_lib/availability";
import { customerName } from "../../_lib/labels";
import { moveBookingAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Move booking" };

export default async function MoveBookingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await getAdminContext();
  const detail = await getBookingDetail(ctx.db, id);
  if (!detail || !canAccessVenue(ctx.user, detail.booking.venueId)) {
    redirect(withFlash("/admin/bookings", "We could not find that booking, or it belongs to another venue.", "error"));
  }
  const { booking: b, venue, customer } = detail;
  if (b.status !== "confirmed") redirect(withFlash(`/admin/bookings/${b.id}`, "Only a confirmed booking can be moved.", "error"));
  const service = await getService(ctx.db, b.serviceId, { includeArchived: true });
  if (!service) redirect(withFlash(`/admin/bookings/${b.id}`, "That service no longer exists.", "error"));

  const tz = ctx.org.timezone;
  const today = todayIn(tz);
  const bookingDay = localDate(b.startsAt, tz);
  const date = dateParam(sp.date, bookingDay < today ? today : bookingDay);
  const path = `/admin/bookings/${b.id}/move?date=${date}`;
  const isSlot = service.kind === "slot";
  const lengthMinutes = minutesBetween(b.startsAt, b.endsAt);
  const extraMinutes = Math.max(0, lengthMinutes - service.lengthMinutes);

  const sessions = isSlot ? [] : await adminSessionChoices(ctx.db, { venue, service, date, tz, excludeBookingId: b.id });
  const slots = isSlot ? await adminSlotChoices(ctx.db, { venue, service, date, tz, extraMinutes, excludeBookingId: b.id }) : [];

  const choiceClass = (enabled: boolean, current: boolean) =>
    cn(
      "flex w-full min-h-14 items-center justify-between gap-3 rounded-2xl border-2 px-4 py-3 text-left",
      current ? "border-brand-strong bg-brand-soft" : enabled ? "border-line bg-surface hover:border-ink/40" : "border-line bg-canvas text-muted",
    );

  return (
    <>
      <PageHeader
        back={{ href: `/admin/bookings/${b.id}`, label: b.reference }}
        title={`Move ${customerName(customer)}`}
        subtitle={`${service.name} · now ${fmtDayLong(b.startsAt, tz)} at ${fmtTime(b.startsAt, tz)} · ${b.places} ${isSlot ? "children" : b.places === 1 ? "place" : "places"}`}
      />
      <Banner tone="info" className="mb-4">
        Pick the new {isSlot ? "start time" : "session"}. The parent gets a fresh confirmation email with the new time.
      </Banner>
      <DateNav value={date} today={today} label={fmtDayLong(startOfLocalDay(date, tz), tz)} />

      {isSlot ? (
        slots.length ? (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {slots.map((slot) => {
              const current = slot.startsAt.getTime() === b.startsAt.getTime();
              return (
                <li key={slot.startsAt.toISOString()}>
                  <form action={moveBookingAction}>
                    <input type="hidden" name="bookingId" value={b.id} />
                    <input type="hidden" name="back" value={path} />
                    <input type="hidden" name="startsAt" value={slot.startsAt.toISOString()} />
                    <button type="submit" disabled={!slot.bookable || current} className={choiceClass(slot.bookable, current)}>
                      <span className="text-lg font-bold tabular-nums">
                        {fmtTime(slot.startsAt, tz)}–{fmtTime(slot.endsAt, tz)}
                      </span>
                      <span className="text-sm">
                        {current
                          ? "Now"
                          : slot.reason
                            ? STAFF_REASON[slot.reason]
                            : slot.timing === "past"
                              ? "Started"
                              : slot.timing === "inside_cutoff"
                                ? "Inside cut-off"
                                : ""}
                      </span>
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title="No start times on this day">The venue is closed, or a party would not fit in the opening hours.</EmptyState>
        )
      ) : sessions.length ? (
        <ul className="flex flex-col gap-2">
          {sessions.map((a) => {
            const current = a.sessionId === b.sessionId;
            const fits = a.bookable && a.remaining >= b.places;
            return (
              <li key={a.sessionId}>
                <form action={moveBookingAction}>
                  <input type="hidden" name="bookingId" value={b.id} />
                  <input type="hidden" name="back" value={path} />
                  <input type="hidden" name="sessionId" value={a.sessionId} />
                  <button type="submit" disabled={!fits || current} className={choiceClass(fits, current)}>
                    <span>
                      <span className="block text-lg font-bold tabular-nums">
                        {fmtTime(a.startsAt, tz)}–{fmtTime(a.endsAt, tz)}
                      </span>
                      <span className="block text-sm">
                        Places taken {a.taken + a.held} of {a.capacity}
                        {a.bookable && a.timing === "inside_cutoff" ? " · inside the online cut-off" : ""}
                        {a.bookable && a.timing === "past" ? " · already started" : ""}
                      </span>
                    </span>
                    <span className="shrink-0">
                      {current ? (
                        <Badge tone="brand">Now</Badge>
                      ) : a.reason ? (
                        <Badge tone="grey">{STAFF_REASON[a.reason]}</Badge>
                      ) : a.remaining < b.places ? (
                        <Badge tone="amber">Only {a.remaining} left</Badge>
                      ) : null}
                    </span>
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState title="No sessions on this day">Try another day.</EmptyState>
      )}

      <div className="mt-6">
        <Button href={`/admin/bookings/${b.id}`} variant="secondary" block>
          Keep the current time
        </Button>
      </div>
    </>
  );
}
