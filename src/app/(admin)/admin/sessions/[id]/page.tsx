import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fmtDayLong, fmtPence, fmtTime, localDate } from "@/core/time";
import { canAccessVenue } from "@/server/auth";
import { getAdminContext } from "@/server/venue-scope";
import { Badge, Button, Card, EmptyState, PageHeader, SectionTitle, Stat, plural } from "@/components/ui";
import { loadSessionDetail } from "../../_lib/schedule";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Session" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAdminContext();
  if (!UUID.test(id)) notFound();
  const detail = await loadSessionDetail(ctx.db, id);
  // Same answer for "missing" and "not yours", so ids cannot be probed across venues.
  if (!detail || !canAccessVenue(ctx.user, detail.session.venueId)) notFound();

  const tz = ctx.org.timezone;
  const { session, service, room, venue, bookings, taken, held } = detail;
  const date = localDate(session.startsAt, tz);
  const left = Math.max(session.capacity - taken - held, 0);
  const live = bookings.filter((b) => b.status === "pending" || b.status === "confirmed");
  const other = bookings.filter((b) => b.status !== "pending" && b.status !== "confirmed");

  return (
    <>
      <PageHeader
        back={{ href: `/admin?date=${date}`, label: "Back to the day" }}
        title={`${fmtTime(session.startsAt, tz)}–${fmtTime(session.endsAt, tz)} ${service.name}`}
        subtitle={`${fmtDayLong(session.startsAt, tz)} · ${venue.name} · ${room.name}`}
        actions={
          session.status === "cancelled" ? (
            <Badge status="cancelled" />
          ) : taken >= session.capacity ? (
            <Badge status="full" />
          ) : null
        }
      />

      <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-3">
        <Stat label="Places taken" value={`${taken} of ${session.capacity}`} />
        <Stat label="Being paid for" value={held} hint={held ? "Held while paying" : undefined} />
        <Stat label="Places left" value={session.status === "cancelled" ? 0 : left} />
      </div>

      <section aria-label="Session actions" className="mt-4 flex flex-wrap gap-2">
        {session.status !== "cancelled" ? (
          <Button
            href={`/admin/bookings/new?${new URLSearchParams({ venue: venue.slug, date, session: session.id }).toString()}`}
            size="lg"
          >
            Add a booking to this session
          </Button>
        ) : null}
        <Button href={`/admin/catalogue/sessions?${new URLSearchParams({ venue: venue.slug, date }).toString()}`} variant="secondary" size="lg">
          Change places or cancel
        </Button>
      </section>

      <SectionTitle aside={live.length ? plural(live.length, "booking", "bookings") : undefined}>Who is coming</SectionTitle>
      {live.length ? (
        <ul className="flex flex-col gap-2">
          {live.map((b) => (
            <Card key={b.id} as="li" href={`/admin/bookings/${b.id}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-base font-bold text-ink">{b.customerName}</p>
                  <p className="text-base">
                    {b.lines.length ? b.lines.map((l) => `${l.qty} × ${l.name}`).join(", ") : plural(b.places, "place", "places")}
                  </p>
                  <p className="text-sm text-muted">
                    {b.reference}
                    {b.phone ? ` · ${b.phone}` : ""} · {fmtPence(b.totalPence)}
                  </p>
                  {b.notes ? <p className="mt-1 text-sm">Note: {b.notes}</p> : null}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {b.status === "pending" ? <Badge status="pending" /> : null}
                  <Badge status={b.paymentStatus === "unpaid" ? "unpaid" : b.paymentStatus} />
                </div>
              </div>
            </Card>
          ))}
        </ul>
      ) : session.status === "cancelled" ? (
        <EmptyState title="No bookings">This session is cancelled, so it cannot be booked.</EmptyState>
      ) : (
        <EmptyState title="No bookings yet">Places are open until the cut-off.</EmptyState>
      )}

      {other.length ? (
        <>
          <SectionTitle>Cancelled and no-shows</SectionTitle>
          <ul className="flex flex-col gap-2">
            {other.map((b) => (
              <Card key={b.id} as="li" href={`/admin/bookings/${b.id}`} tone="muted">
                <div className="flex items-center justify-between gap-2">
                  <span>
                    <span className="font-semibold text-ink">{b.customerName}</span> · {plural(b.places, "place", "places")} · {b.reference}
                  </span>
                  <Badge status={b.status} />
                </div>
              </Card>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
