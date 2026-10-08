import type { Metadata } from "next";
import Link from "next/link";
import { fmtDayLong, fmtTime, startOfLocalDay } from "@/core/time";
import { canManageCatalogue } from "@/server/auth";
import { listServicesForVenue } from "@/server/catalogue";
import { listSessionsForDay } from "@/server/catalogue-admin";
import { getAdminContext } from "@/server/venue-scope";
import { Badge, Button, Card, Checkbox, ConfirmButton, DateNav, EmptyState, Field, Input, PageHeader, SectionTitle, SegmentedControl, Select } from "@/components/ui";
import { dateParam, relativeDayName, todayIn, type SearchParams } from "../../_lib/dates";
import { addExtraSessionAction, cancelSessionAction, restoreSessionAction, setSessionCapacityAction } from "../actions";
import { pickVenue, venueTabs } from "../_lib/venue";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sessions" };

export default async function SessionsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await getAdminContext();
  const sp = await searchParams;
  const venue = pickVenue(ctx, sp.venue);
  if (!venue) return <EmptyState title="No venue yet">Your account is not linked to a venue.</EmptyState>;
  const tz = ctx.org.timezone;
  const today = todayIn(tz);
  const date = dateParam(sp.date, today);
  const canManage = canManageCatalogue(ctx.user, venue.id);
  const [sessions, services] = await Promise.all([
    listSessionsForDay(ctx.db, venue.id, date, tz),
    listServicesForVenue(ctx.db, venue.id),
  ]);
  const sessionServices = services.filter((x) => x.kind === "session");
  const label = fmtDayLong(startOfLocalDay(date, tz), tz);
  const rel = relativeDayName(date, today);
  const back = `/admin/catalogue/sessions?${new URLSearchParams({ venue: venue.slug, date }).toString()}`;
  const tabs = venueTabs(ctx, "/admin/catalogue/sessions", { date });
  const past = date < today;

  return (
    <>
      <PageHeader
        back={{ href: `/admin/catalogue?venue=${venue.slug}`, label: "Catalogue" }}
        title="Sessions"
        subtitle={`${venue.name}: change one session, cancel it, or add an extra one`}
      />
      {tabs.length ? <SegmentedControl aria-label="Venue" options={tabs} value={venue.id} className="mb-4" /> : null}
      <DateNav value={date} today={today} label={rel ? `${rel}, ${label}` : label} />

      {sessions.length ? (
        <ul className="flex flex-col gap-2">
          {sessions.map((x) => {
            const cancelled = x.status === "cancelled";
            const left = Math.max(x.capacity - x.taken, 0);
            return (
              <Card key={x.id} as="li" accent={x.colour} tone={cancelled ? "muted" : "default"}>
                <div className="flex items-start justify-between gap-2">
                  <Link href={`/admin/sessions/${x.id}`} className="min-w-0 text-ink no-underline">
                    <span className="block text-lg font-bold tabular-nums">
                      {fmtTime(x.startsAt, tz)}–{fmtTime(x.endsAt, tz)} {x.serviceName}
                    </span>
                    <span className="block text-sm text-muted">
                      {x.roomName} · Places taken {x.taken} of {x.capacity}
                      {!cancelled ? ` · ${left} left` : ""}
                    </span>
                    <span className="text-sm font-semibold text-brand-strong">Who is coming ›</span>
                  </Link>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    {cancelled ? <Badge status="cancelled" /> : x.taken >= x.capacity ? <Badge status="full" /> : <Badge status="scheduled" />}
                    {x.source === "exception" ? <Badge tone="blue">Extra</Badge> : null}
                    {x.pinned && !cancelled ? <Badge tone="grey">Changed</Badge> : null}
                  </span>
                </div>

                {canManage && !past ? (
                  cancelled ? (
                    <form action={restoreSessionAction} className="mt-3">
                      <input type="hidden" name="sessionId" value={x.id} />
                      <input type="hidden" name="back" value={back} />
                      <Button type="submit" variant="secondary" block>
                        Put this session back on
                      </Button>
                    </form>
                  ) : (
                    <details className="mt-3">
                      <summary className="min-h-11 cursor-pointer font-semibold text-brand-strong">Change places or cancel</summary>
                      <form action={setSessionCapacityAction} className="mt-2 flex items-end gap-2">
                        <input type="hidden" name="sessionId" value={x.id} />
                        <input type="hidden" name="back" value={back} />
                        <Field label="Places for this session only" htmlFor={`cap-${x.id}`} className="mb-0 flex-1">
                          <Input id={`cap-${x.id}`} name="capacity" type="number" inputMode="numeric" min={x.taken} max={500} defaultValue={x.capacity} required />
                        </Field>
                        <Button type="submit" variant="secondary">
                          Save
                        </Button>
                      </form>
                      <form action={cancelSessionAction} className="mt-4">
                        <input type="hidden" name="sessionId" value={x.id} />
                        <input type="hidden" name="back" value={back} />
                        {x.confirmedBookings > 0 ? (
                          <Checkbox
                            name="acknowledge"
                            required
                            label={`I will move or cancel the ${x.confirmedBookings === 1 ? "booking" : `${x.confirmedBookings} bookings`} myself`}
                            hint="Cancelling the session does not cancel or refund its bookings."
                          />
                        ) : null}
                        <ConfirmButton variant="danger" block prompt="Cancel this session? It will no longer be offered." confirmLabel="Yes, cancel it" cancelLabel="No, keep it">
                          Cancel this session
                        </ConfirmButton>
                      </form>
                    </details>
                  )
                ) : null}
              </Card>
            );
          })}
        </ul>
      ) : (
        <EmptyState title="No sessions on this day">
          {venue.opensAt && startOfLocalDay(date, tz) < venue.opensAt
            ? `${venue.name} opens on ${fmtDayLong(venue.opensAt, tz)}.`
            : "The timetable has nothing on this day. You can add an extra session below."}
        </EmptyState>
      )}

      {canManage && !past && sessionServices.length ? (
        <>
          <SectionTitle>Add an extra session</SectionTitle>
          <form action={addExtraSessionAction} className="rounded-2xl border border-line bg-surface p-4">
            <input type="hidden" name="date" value={date} />
            <input type="hidden" name="back" value={back} />
            <Field label="Service" htmlFor="extra-service">
              <Select id="extra-service" name="serviceId" options={sessionServices.map((x) => ({ value: x.id, label: x.name }))} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start time" htmlFor="extra-time">
                <Input id="extra-time" name="startTime" type="time" step={300} required />
              </Field>
              <Field label="Places" htmlFor="extra-cap">
                <Input id="extra-cap" name="capacity" type="number" inputMode="numeric" min={1} max={500} defaultValue={10} required />
              </Field>
            </div>
            <Button type="submit" block>
              Add session on {rel ?? label}
            </Button>
          </form>
        </>
      ) : null}
    </>
  );
}
