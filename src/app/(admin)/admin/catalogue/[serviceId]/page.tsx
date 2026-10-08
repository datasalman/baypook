import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { localDate } from "@/core/time";
import { canAccessVenue, canManageCatalogue } from "@/server/auth";
import { getService } from "@/server/catalogue";
import { listUpcomingExceptions } from "@/server/catalogue-admin";
import { getAdminContext } from "@/server/venue-scope";
import { Badge, Banner, PageHeader } from "@/components/ui";
import { DetailsSection } from "./_components/DetailsSection";
import { OptionsSection } from "./_components/OptionsSection";
import { AddOnsSection } from "./_components/AddOnsSection";
import { TimetableSection } from "./_components/TimetableSection";
import { ExceptionsSection } from "./_components/ExceptionsSection";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Service" };

export default async function ServicePage({ params }: { params: Promise<{ serviceId: string }> }) {
  const { serviceId } = await params;
  const ctx = await getAdminContext();
  const svc = await getService(ctx.db, serviceId, { includeArchived: true });
  // Same answer for "missing" and "not yours".
  if (!svc || !canAccessVenue(ctx.user, svc.venueId)) notFound();
  const venue = ctx.venues.find((v) => v.id === svc.venueId);
  if (!venue) notFound();

  const canManage = canManageCatalogue(ctx.user, svc.venueId);
  const tz = ctx.org.timezone;
  const today = localDate(new Date(), tz);
  const isSession = svc.kind === "session";
  const [rooms, rules, exceptions] = await Promise.all([
    ctx.db.select().from(s.rooms).where(eq(s.rooms.venueId, svc.venueId)).orderBy(asc(s.rooms.sortOrder), asc(s.rooms.name)),
    isSession
      ? ctx.db.select().from(s.timetableRules).where(eq(s.timetableRules.serviceId, svc.id)).orderBy(asc(s.timetableRules.startTime))
      : Promise.resolve([] as s.TimetableRule[]),
    isSession ? listUpcomingExceptions(ctx.db, svc.id, today) : Promise.resolve([] as s.TimetableException[]),
  ]);
  const here = `/admin/catalogue/${svc.id}`;
  const liveOptions = svc.options.filter((o) => !o.archivedAt);

  const jump = [
    { id: "details", label: "Details" },
    { id: "options", label: isSession ? "Options" : "Package" },
    { id: "addons", label: "Add-ons" },
    ...(isSession
      ? [
          { id: "timetable", label: "Timetable" },
          { id: "changes", label: "One-off changes" },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        back={{ href: `/admin/catalogue?venue=${venue.slug}`, label: "Catalogue" }}
        title={svc.name}
        subtitle={`${venue.name} · ${svc.room.name} · ${isSession ? "Workshop sessions" : "Party slots"}`}
        actions={
          <>
            {svc.archivedAt ? <Badge tone="grey">Archived</Badge> : null}
            <Badge tone={svc.onlineEnabled ? "green" : "amber"}>{svc.onlineEnabled ? "Online on" : "Online off"}</Badge>
          </>
        }
      />

      {!canManage ? <Banner tone="info" className="mb-4">You can look, but only the owner or a manager can make changes here.</Banner> : null}
      {!svc.archivedAt && liveOptions.length === 0 ? (
        <Banner className="mb-4">No options yet, so customers cannot book this. Add {isSession ? "an option with a price" : "the party package"} below.</Banner>
      ) : null}
      {!svc.archivedAt && isSession && rules.length === 0 ? (
        <Banner className="mb-4">No timetable yet, so there are no sessions. Add times below or fill them from opening hours.</Banner>
      ) : null}

      <nav aria-label="Sections" className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-10 -mx-4 mb-4 flex gap-1 overflow-x-auto bg-canvas/95 px-4 py-2 backdrop-blur">
        {jump.map((j) => (
          <a
            key={j.id}
            href={`#${j.id}`}
            className="flex min-h-11 shrink-0 items-center rounded-lg border border-line bg-surface px-3 text-sm font-semibold text-ink no-underline hover:border-ink/40"
          >
            {j.label}
          </a>
        ))}
      </nav>

      <DetailsSection service={svc} rooms={rooms} canManage={canManage} back={`${here}#details`} />
      <OptionsSection service={svc} canManage={canManage} back={`${here}#options`} />
      <AddOnsSection service={svc} canManage={canManage} back={`${here}#addons`} />
      {isSession ? (
        <>
          <TimetableSection service={svc} venue={venue} rules={rules} canManage={canManage} back={`${here}#timetable`} />
          <ExceptionsSection service={svc} exceptions={exceptions} today={today} canManage={canManage} back={`${here}#changes`} />
        </>
      ) : null}
    </>
  );
}
