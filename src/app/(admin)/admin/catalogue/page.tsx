import type { Metadata } from "next";
import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { canManageCatalogue } from "@/server/auth";
import { listServicesForVenue } from "@/server/catalogue";
import { getAdminContext } from "@/server/venue-scope";
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, SectionTitle, SegmentedControl, Select } from "@/components/ui";
import type { SearchParams } from "../_lib/dates";
import { createServiceAction, moveServiceAction } from "./actions";
import { fmtMinutes, minutesToHoursField, pickVenue, venueTabs } from "./_lib/venue";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Catalogue" };

export default async function CataloguePage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await getAdminContext();
  const sp = await searchParams;
  const venue = pickVenue(ctx, sp.venue);
  if (!venue) {
    return <EmptyState title="No venue yet">Your account is not linked to a venue. Ask the owner to add you to one.</EmptyState>;
  }
  const showArchived = sp.archived === "1";
  const canManage = canManageCatalogue(ctx.user, venue.id);
  const [all, rooms] = await Promise.all([
    listServicesForVenue(ctx.db, venue.id, { includeArchived: true }),
    ctx.db.select().from(s.rooms).where(eq(s.rooms.venueId, venue.id)).orderBy(asc(s.rooms.sortOrder), asc(s.rooms.name)),
  ]);
  const live = all.filter((x) => !x.archivedAt);
  const archived = all.filter((x) => x.archivedAt);
  const tabs = venueTabs(ctx, "/admin/catalogue");
  const here = `/admin/catalogue?venue=${venue.slug}${showArchived ? "&archived=1" : ""}`;

  return (
    <>
      <PageHeader
        title="Catalogue"
        subtitle={`${venue.name}: what can be booked, prices and times`}
        actions={
          <>
            <Button href={`/admin/catalogue/sessions?venue=${venue.slug}`} variant="secondary">
              Sessions on a day
            </Button>
            <Button href={`/admin/catalogue/blocks?venue=${venue.slug}`} variant="secondary">
              Blocked time
            </Button>
          </>
        }
      />
      {tabs.length ? <SegmentedControl aria-label="Venue" options={tabs} value={venue.id} className="mb-4" /> : null}
      {!canManage ? (
        <p className="mb-4 rounded-xl bg-brand-soft px-3 py-2 text-sm">You can look, but only the owner or a manager can make changes here.</p>
      ) : null}

      <SectionTitle aside={`${live.length} live`}>Services</SectionTitle>
      {live.length ? (
        <ul className="flex flex-col gap-2">
          {live.map((svc, i) => (
            <Card key={svc.id} as="li" accent={svc.colour}>
              <div className="flex items-start gap-2">
                <Link href={`/admin/catalogue/${svc.id}`} className="min-w-0 flex-1 text-ink no-underline">
                  <span className="block text-lg font-bold">{svc.name}</span>
                  <span className="mt-1 flex flex-wrap gap-1.5">
                    <Badge tone={svc.kind === "session" ? "brand" : "blue"}>{svc.kind === "session" ? "Workshop sessions" : "Party slots"}</Badge>
                    <Badge tone="grey">{svc.lengthMinutes} min</Badge>
                    <Badge tone={svc.onlineEnabled ? "green" : "amber"}>{svc.onlineEnabled ? "Online on" : "Online off"}</Badge>
                    {svc.payInStoreEnabled ? <Badge tone="amber">Pay in store</Badge> : null}
                  </span>
                  <span className="mt-1 block text-sm text-muted">
                    {svc.options.length ? svc.options.map((o) => o.name).join(", ") : "No options yet: it cannot be booked"} · {svc.room.name}
                  </span>
                  <span className="block text-sm text-muted">
                    Notice: {fmtMinutes(svc.leadTimeMinutes)} · Closes {svc.cutoffMinutes ? `${fmtMinutes(svc.cutoffMinutes)} before` : "at the start"}
                  </span>
                </Link>
                {canManage && live.length > 1 ? (
                  <div className="flex shrink-0 flex-col gap-1">
                    <form action={moveServiceAction}>
                      <input type="hidden" name="serviceId" value={svc.id} />
                      <input type="hidden" name="direction" value="up" />
                      <input type="hidden" name="back" value={here} />
                      <Button type="submit" variant="secondary" size="sm" disabled={i === 0} aria-label={`Move ${svc.name} up`}>
                        ↑
                      </Button>
                    </form>
                    <form action={moveServiceAction}>
                      <input type="hidden" name="serviceId" value={svc.id} />
                      <input type="hidden" name="direction" value="down" />
                      <input type="hidden" name="back" value={here} />
                      <Button type="submit" variant="secondary" size="sm" disabled={i === live.length - 1} aria-label={`Move ${svc.name} down`}>
                        ↓
                      </Button>
                    </form>
                  </div>
                ) : null}
              </div>
            </Card>
          ))}
        </ul>
      ) : (
        <EmptyState title="Nothing to book yet">Add a service below: workshop sessions run on a timetable, party slots start at any free time.</EmptyState>
      )}
      <p className="mt-2 text-sm text-muted">Customers see services in this order.</p>

      {archived.length ? (
        <div className="mt-4">
          <Link
            href={`/admin/catalogue?venue=${venue.slug}${showArchived ? "" : "&archived=1"}`}
            className="inline-flex min-h-11 items-center text-base font-semibold text-brand-strong"
          >
            {showArchived ? "Hide archived" : `Show archived (${archived.length})`}
          </Link>
          {showArchived ? (
            <ul className="mt-2 flex flex-col gap-2">
              {archived.map((svc) => (
                <Card key={svc.id} as="li" tone="muted" href={`/admin/catalogue/${svc.id}`}>
                  <span className="font-semibold text-ink">{svc.name}</span> <Badge tone="grey">Archived</Badge>
                </Card>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {canManage ? (
        <details className="mt-6 rounded-2xl border border-line bg-surface p-4">
          <summary className="min-h-11 cursor-pointer text-lg font-bold">Add a service</summary>
          <form action={createServiceAction} className="mt-4">
            <input type="hidden" name="venueId" value={venue.id} />
            <input type="hidden" name="back" value={`/admin/catalogue?venue=${venue.slug}`} />
            <Field label="Kind" htmlFor="new-kind" hint="Workshops sell places in timed sessions. Parties book the room for one group.">
              <Select
                id="new-kind"
                name="kind"
                defaultValue="session"
                options={[
                  { value: "session", label: "Workshop sessions (places on a timetable)" },
                  { value: "slot", label: "Party slots (one booking per time)" },
                ]}
              />
            </Field>
            <Field label="Name" htmlFor="new-name">
              <Input id="new-name" name="name" required maxLength={120} placeholder="e.g. Classic Workshops" />
            </Field>
            <Field label="Room" htmlFor="new-room">
              <Select id="new-room" name="roomId" options={rooms.map((r) => ({ value: r.id, label: r.name }))} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Length (minutes)" htmlFor="new-length">
                <Input id="new-length" name="lengthMinutes" type="number" inputMode="numeric" min={5} max={1440} step={5} defaultValue={60} required />
              </Field>
              <Field label="Party start times every (minutes)" htmlFor="new-interval" hint="Party slots only">
                <Input id="new-interval" name="slotIntervalMinutes" type="number" inputMode="numeric" min={5} max={240} step={5} defaultValue={30} />
              </Field>
              <Field label="Notice needed (hours)" htmlFor="new-lead" hint="0 for none; 48 for two days">
                <Input
                  id="new-lead"
                  name="leadTimeHours"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="any"
                  defaultValue={minutesToHoursField(venue.defaultLeadTimeMinutes)}
                  required
                />
              </Field>
              <Field label="Booking closes (minutes before)" htmlFor="new-cutoff">
                <Input id="new-cutoff" name="cutoffMinutes" type="number" inputMode="numeric" min={0} step={5} defaultValue={venue.defaultCutoffMinutes} required />
              </Field>
            </div>
            <Field label="Colour" htmlFor="new-colour" hint="Used on the calendar">
              <Input id="new-colour" name="colour" type="color" defaultValue="#5bbf3a" className="max-w-32" />
            </Field>
            <p className="mb-3 text-sm text-muted">New services start with online booking off, so you can add prices and times first.</p>
            <Button type="submit" block>
              Add service
            </Button>
          </form>
        </details>
      ) : null}

      {!ctx.user.isOwner && canManage ? (
        <p className="mt-6 text-sm text-muted">
          Venue details and the most places per booking are in{" "}
          <Link href={`/admin/settings/venues/${venue.id}`}>{venue.name} details</Link>.
        </p>
      ) : null}
    </>
  );
}
