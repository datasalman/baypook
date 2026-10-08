import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { timingReason } from "@/core/availability";
import { fmtDayLong, fmtTime, isValidTimeStr, localDate, startOfLocalDay, zonedDateTime } from "@/core/time";
import { canAccessVenue } from "@/server/auth";
import { getService, isUuid, listServicesForVenue, type ServiceWithCatalogue } from "@/server/catalogue";
import { getAdminContext } from "@/server/venue-scope";
import { Badge, Banner, Card, DateNav, EmptyState, PageHeader, SectionTitle } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import { dateParam, todayIn, type SearchParams } from "../../_lib/dates";
import { canSeeCustomer } from "../../customers/_lib/customers";
import { adminSessionChoices, adminSlotChoices, STAFF_REASON } from "../_lib/availability";
import { editorCatalogue } from "../_lib/catalogue";
import { hasRealEmail } from "../_lib/labels";
import { NewBookingForm, type CustomerPrefill } from "./NewBookingForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "New booking" };

const KEYS = ["venue", "service", "date", "session", "start", "extra", "customer"] as const;
type Key = (typeof KEYS)[number];

function one(v: string | string[] | undefined): string {
  return ((Array.isArray(v) ? v[0] : v) ?? "").trim();
}

function StepLink({ href, label, value }: { href: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm text-muted">{label}</p>
        <p className="font-semibold">{value}</p>
      </div>
      <Link href={href} className="flex min-h-11 items-center px-2 text-sm font-semibold text-brand-strong">
        Change<span className="sr-only"> {label.toLowerCase()}</span>
      </Link>
    </div>
  );
}

export default async function NewBookingPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await getAdminContext();
  const sp = await searchParams;
  const tz = ctx.org.timezone;
  const today = todayIn(tz);
  const now = new Date();

  const params: Record<Key, string> = {
    venue: one(sp.venue),
    service: one(sp.service),
    date: one(sp.date),
    session: one(sp.session) || one(sp.sessionId),
    start: one(sp.start),
    extra: one(sp.extra),
    customer: one(sp.customer),
  };
  const href = (changes: Partial<Record<Key, string | null>>) => {
    const q = new URLSearchParams();
    for (const k of KEYS) {
      const v = k in changes ? changes[k] : params[k];
      if (v) q.set(k, v);
    }
    const qs = q.toString();
    return qs ? `/admin/bookings/new?${qs}` : "/admin/bookings/new";
  };

  // ----- customer to preselect -----
  let prefill: CustomerPrefill | null = null;
  if (isUuid(params.customer) && (await canSeeCustomer(ctx.db, ctx.user, params.customer))) {
    const [c] = await ctx.db.select().from(s.customers).where(eq(s.customers.id, params.customer)).limit(1);
    if (c && !c.anonymisedAt) {
      prefill = { firstName: c.firstName, lastName: c.lastName, email: hasRealEmail(c.email) ? c.email : "", phone: c.phone ?? "" };
    }
  }

  // ----- a session given directly (from the session page) -----
  let problem: string | null = null;
  let session: s.Session | null = null;
  if (params.session) {
    const [row] = isUuid(params.session) ? await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, params.session)).limit(1) : [];
    if (row && canAccessVenue(ctx.user, row.venueId)) {
      session = row;
      params.date = localDate(row.startsAt, tz);
    } else {
      problem = "That session was not found.";
      params.session = "";
    }
  }

  // ----- venue -----
  const sessionVenueId = session?.venueId;
  const venue =
    (sessionVenueId ? ctx.venues.find((v) => v.id === sessionVenueId) : undefined) ??
    ctx.venues.find((v) => v.slug === params.venue) ??
    (ctx.selectedVenues.length === 1 ? ctx.selectedVenues[0] : undefined) ??
    (ctx.venues.length === 1 ? ctx.venues[0] : undefined);
  if (venue) params.venue = venue.slug;

  // ----- service -----
  let service: ServiceWithCatalogue | null = null;
  const serviceId = session?.serviceId ?? params.service;
  if (venue && isUuid(serviceId)) {
    const svc = await getService(ctx.db, serviceId);
    if (svc && svc.venueId === venue.id) service = svc;
  }
  if (service) params.service = service.id;
  if (session && (!service || session.serviceId !== service.id)) {
    session = null;
    params.session = "";
  }

  const date = dateParam(params.date, today);
  params.date = date;
  const dayLabel = fmtDayLong(startOfLocalDay(date, tz), tz);

  // ----- time -----
  const timeAddOn = service?.addOns.find((a) => a.kind === "time" && !a.archivedAt) ?? null;
  const extra = timeAddOn && Number(params.extra) > 0 ? timeAddOn.extraMinutes : 0;
  let startsAt: Date | null = null;
  if (service?.kind === "slot" && isValidTimeStr(params.start)) startsAt = zonedDateTime(date, params.start, tz);

  // ----- what to show -----
  const summary: { label: string; value: string; href: string }[] = [];
  if (venue && ctx.venues.length > 1) summary.push({ label: "Venue", value: venue.name, href: href({ venue: null, service: null, session: null, start: null, extra: null }) });
  if (service) summary.push({ label: "What", value: service.name, href: href({ service: null, session: null, start: null, extra: null }) });

  let body: ReactNode;
  if (!ctx.venues.length) {
    body = <EmptyState title="No venue yet">Your account is not linked to a venue.</EmptyState>;
  } else if (!venue) {
    body = (
      <>
        <SectionTitle>Which venue?</SectionTitle>
        <ul className="flex flex-col gap-2">
          {ctx.venues.map((v) => (
            <Card key={v.id} as="li" href={href({ venue: v.slug, service: null, session: null, start: null })}>
              <span className="text-lg font-bold">{v.name}</span>
            </Card>
          ))}
        </ul>
      </>
    );
  } else if (!service) {
    const services = await listServicesForVenue(ctx.db, venue.id);
    body = (
      <>
        <SectionTitle>What are they booking?</SectionTitle>
        {services.length ? (
          <ul className="flex flex-col gap-2">
            {services.map((svc) => (
              <Card key={svc.id} as="li" accent={svc.colour} href={href({ service: svc.id, session: null, start: null, extra: null })}>
                <span className="block text-lg font-bold">{svc.name}</span>
                <span className="block text-sm text-muted">
                  {svc.kind === "slot" ? "Party" : "Workshop session"} · {svc.lengthMinutes} min
                  {svc.onlineEnabled ? "" : " · not bookable online"}
                </span>
              </Card>
            ))}
          </ul>
        ) : (
          <EmptyState title="Nothing to book here yet">Add a service in the Catalogue first.</EmptyState>
        )}
      </>
    );
  } else if (service.kind === "session" && !session) {
    const choices = await adminSessionChoices(ctx.db, { venue, service, date, tz, now });
    body = (
      <>
        <SectionTitle>Which session?</SectionTitle>
        <DateNav value={date} today={today} label={dayLabel} />
        {choices.length ? (
          <ul className="flex flex-col gap-2">
            {choices.map((a) => {
              const label = (
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-lg font-bold tabular-nums">
                      {fmtTime(a.startsAt, tz)}–{fmtTime(a.endsAt, tz)}
                    </p>
                    <p>
                      Places taken {a.taken + a.held} of {a.capacity}
                    </p>
                    {a.bookable && a.timing === "inside_cutoff" ? <p className="text-sm text-muted">Inside the online cut-off</p> : null}
                    {a.bookable && a.timing === "past" ? (
                      <p className="text-sm text-muted">{a.endsAt.getTime() <= now.getTime() ? "In the past" : "Already started"}</p>
                    ) : null}
                  </div>
                  {a.reason ? <Badge tone="grey">{STAFF_REASON[a.reason]}</Badge> : <Badge tone="green">{a.remaining} left</Badge>}
                </div>
              );
              return a.bookable ? (
                <Card key={a.sessionId} as="li" accent={service.colour} href={href({ session: a.sessionId })}>
                  {label}
                </Card>
              ) : (
                <Card key={a.sessionId} as="li" tone="muted">
                  {label}
                </Card>
              );
            })}
          </ul>
        ) : (
          <EmptyState title="No sessions on this day">Try another day.</EmptyState>
        )}
      </>
    );
  } else if (service.kind === "slot" && !startsAt) {
    const choices = await adminSlotChoices(ctx.db, { venue, service, date, tz, extraMinutes: extra, now });
    body = (
      <>
        <SectionTitle>What time?</SectionTitle>
        <DateNav value={date} today={today} label={dayLabel} />
        {timeAddOn ? (
          <div role="radiogroup" aria-label="Party length" className="mb-4 flex gap-1 rounded-xl bg-[#e6e9e2] p-1">
            {[
              { on: false, text: `${service.lengthMinutes} min` },
              { on: true, text: `${service.lengthMinutes + timeAddOn.extraMinutes} min with ${timeAddOn.name}` },
            ].map((o) => {
              const active = (extra > 0) === o.on;
              return (
                <Link
                  key={String(o.on)}
                  href={href({ extra: o.on ? "1" : null })}
                  role="radio"
                  aria-checked={active}
                  scroll={false}
                  className={cn(
                    "flex min-h-11 flex-1 items-center justify-center rounded-lg px-3 text-center text-sm font-semibold no-underline",
                    active ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink",
                  )}
                >
                  {o.text}
                </Link>
              );
            })}
          </div>
        ) : null}
        {choices.length ? (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {choices.map((c) => {
              const inner = (
                <>
                  <span className="block text-lg font-bold tabular-nums">
                    {fmtTime(c.startsAt, tz)}–{fmtTime(c.endsAt, tz)}
                  </span>
                  <span className="block text-sm">
                    {c.reason ? STAFF_REASON[c.reason] : c.timing === "past" ? "Started" : c.timing === "inside_cutoff" ? "Inside cut-off" : "Free"}
                  </span>
                </>
              );
              return (
                <li key={c.startsAt.toISOString()}>
                  {c.bookable ? (
                    <Link
                      href={href({ start: fmtTime(c.startsAt, tz) })}
                      className="block min-h-14 rounded-2xl border-2 border-line bg-surface px-3 py-2 text-ink no-underline hover:border-ink/40"
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div className="block min-h-14 rounded-2xl border-2 border-line bg-canvas px-3 py-2 text-muted" aria-disabled>
                      {inner}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title="No start times on this day">The venue is closed, or a party would not fit in the opening hours.</EmptyState>
        )}
      </>
    );
  } else {
    // ----- final step: places, parent, payment -----
    let placesLeft: number | null = null;
    let timing: string | null = null;
    let when: Date;
    if (service.kind === "session" && session) {
      const choices = await adminSessionChoices(ctx.db, { venue, service, date, tz, now });
      const mine = choices.find((a) => a.sessionId === session.id);
      placesLeft = mine ? mine.remaining : 0;
      if (mine && !mine.bookable && mine.reason) problem = `This session cannot be booked: ${STAFF_REASON[mine.reason].toLowerCase()}.`;
      if (mine?.timing === "inside_cutoff") timing = "This time is inside the online cut-off: only staff can book it now.";
      if (mine?.timing === "past") timing = "This session has already started.";
      when = session.startsAt;
      summary.push({
        label: "When",
        value: `${fmtDayLong(session.startsAt, tz)}, ${fmtTime(session.startsAt, tz)}–${fmtTime(session.endsAt, tz)} · places taken ${mine ? mine.taken + mine.held : "?"} of ${session.capacity}`,
        href: href({ session: null }),
      });
    } else {
      when = startsAt as Date;
      const reason = timingReason(now, when, service);
      if (reason === "cutoff" || reason === "lead_time") timing = "This time is inside the online notice period: only staff can book it now.";
      if (reason === "past") timing = "This time has already started.";
      summary.push({
        label: "When",
        value: `${fmtDayLong(when, tz)} at ${fmtTime(when, tz)}${extra ? ` (with ${timeAddOn?.name ?? "extra time"})` : ""}`,
        href: href({ start: null }),
      });
    }
    const initialAddOns: Record<string, number> = timeAddOn && extra ? { [timeAddOn.id]: 1 } : {};
    body = (
      <>
        {timing ? <Banner className="mb-3">{timing}</Banner> : null}
        <NewBookingForm
          venueId={venue.id}
          serviceId={service.id}
          sessionId={session?.id ?? null}
          startsAtIso={service.kind === "slot" ? when.toISOString() : null}
          catalogue={editorCatalogue(service, venue)}
          placesLeft={placesLeft}
          initialAddOns={initialAddOns}
          prefill={prefill}
        />
        {service.kind === "slot" && timeAddOn ? (
          <p className="mt-3 text-sm text-muted">
            The times shown were checked for a {service.lengthMinutes + extra} minute party. Adding or removing {timeAddOn.name} here is checked again when you
            create the booking.
          </p>
        ) : null}
      </>
    );
  }

  return (
    <>
      <PageHeader back={{ href: "/admin/bookings", label: "Bookings" }} title="New booking" subtitle="For a phone call or a walk-in" />
      {prefill ? (
        <Banner tone="info" className="mb-3">
          For {prefill.firstName} {prefill.lastName}
        </Banner>
      ) : null}
      {problem ? (
        <Banner tone="danger" className="mb-3">
          {problem}
        </Banner>
      ) : null}
      {summary.length ? (
        <div className="mb-2 divide-y divide-line rounded-2xl border border-line bg-surface">
          {summary.map((r) => (
            <StepLink key={r.label} label={r.label} value={r.value} href={r.href} />
          ))}
        </div>
      ) : null}
      {body}
    </>
  );
}
