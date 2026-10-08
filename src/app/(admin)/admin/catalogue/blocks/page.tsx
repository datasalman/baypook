import type { Metadata } from "next";
import { asc, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { fmtDayShort, fmtTime, localDate, startOfLocalDay, endOfLocalDay } from "@/core/time";
import { canManageCatalogue } from "@/server/auth";
import { listUpcomingBlocks } from "@/server/catalogue-admin";
import { getAdminContext } from "@/server/venue-scope";
import { Badge, Button, Card, ConfirmButton, EmptyState, Field, Input, PageHeader, SectionTitle, SegmentedControl, Select } from "@/components/ui";
import { todayIn, type SearchParams } from "../../_lib/dates";
import { closeDayAction, createBlockAction, deleteBlockAction } from "../actions";
import { pickVenue, venueTabs } from "../_lib/venue";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Blocked time" };

function when(b: { startsAt: Date; endsAt: Date }, tz: string): string {
  const startDay = localDate(b.startsAt, tz);
  const lastDay = localDate(new Date(b.endsAt.getTime() - 1), tz);
  const wholeDays = b.startsAt.getTime() === startOfLocalDay(startDay, tz).getTime() && b.endsAt.getTime() === endOfLocalDay(lastDay, tz).getTime();
  if (wholeDays) {
    return startDay === lastDay ? `${fmtDayShort(b.startsAt, tz)}, all day` : `${fmtDayShort(b.startsAt, tz)} to ${fmtDayShort(b.endsAt, tz)}, all day`;
  }
  if (startDay === localDate(b.endsAt, tz)) return `${fmtDayShort(b.startsAt, tz)}, ${fmtTime(b.startsAt, tz)}–${fmtTime(b.endsAt, tz)}`;
  return `${fmtDayShort(b.startsAt, tz)} ${fmtTime(b.startsAt, tz)} to ${fmtDayShort(b.endsAt, tz)} ${fmtTime(b.endsAt, tz)}`;
}

export default async function BlocksPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await getAdminContext();
  const sp = await searchParams;
  const venue = pickVenue(ctx, sp.venue);
  if (!venue) return <EmptyState title="No venue yet">Your account is not linked to a venue.</EmptyState>;
  const tz = ctx.org.timezone;
  const today = todayIn(tz);
  const canManage = canManageCatalogue(ctx.user, venue.id);
  const [blocks, rooms] = await Promise.all([
    listUpcomingBlocks(ctx.db, [venue.id]),
    ctx.db.select().from(s.rooms).where(eq(s.rooms.venueId, venue.id)).orderBy(asc(s.rooms.sortOrder), asc(s.rooms.name)),
  ]);
  const back = `/admin/catalogue/blocks?venue=${venue.slug}`;
  const tabs = venueTabs(ctx, "/admin/catalogue/blocks");

  return (
    <>
      <PageHeader
        back={{ href: `/admin/catalogue?venue=${venue.slug}`, label: "Catalogue" }}
        title="Blocked time"
        subtitle={`${venue.name}: closed days, private hire and room closures. Nothing can be booked in blocked time.`}
      />
      {tabs.length ? <SegmentedControl aria-label="Venue" options={tabs} value={venue.id} className="mb-4" /> : null}

      {canManage ? (
        <form action={closeDayAction} className="mb-4 rounded-2xl border border-line bg-surface p-4">
          <input type="hidden" name="venueId" value={venue.id} />
          <input type="hidden" name="back" value={back} />
          <p className="mb-2 text-lg font-bold">Close a whole day</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date" htmlFor="close-date">
              <Input id="close-date" name="date" type="date" min={today} required />
            </Field>
            <Field label="Reason" htmlFor="close-reason" optional>
              <Input id="close-reason" name="reason" placeholder="Closed" maxLength={200} />
            </Field>
          </div>
          <Button type="submit" block>
            Close the day
          </Button>
        </form>
      ) : null}

      <SectionTitle aside={blocks.length ? `${blocks.length} coming up` : undefined}>Coming up</SectionTitle>
      {blocks.length ? (
        <ul className="flex flex-col gap-2">
          {blocks.map((b) => (
            <Card key={b.id} as="li" tone="block">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="block font-bold">{when(b, tz)}</span>
                  <span className="text-sm">
                    {b.reason || "Blocked"} · <Badge tone="grey">{b.roomName ?? "Whole venue"}</Badge>
                  </span>
                </span>
                {canManage ? (
                  <form action={deleteBlockAction}>
                    <input type="hidden" name="blockId" value={b.id} />
                    <input type="hidden" name="back" value={back} />
                    <ConfirmButton size="sm" variant="secondary" prompt="Remove this blocked time? Bookings can be made again." confirmLabel="Remove">
                      Remove
                    </ConfirmButton>
                  </form>
                ) : null}
              </div>
            </Card>
          ))}
        </ul>
      ) : (
        <EmptyState title="Nothing blocked">Every open hour can be booked.</EmptyState>
      )}

      {canManage ? (
        <details className="mt-6 rounded-2xl border border-dashed border-line bg-surface p-4">
          <summary className="min-h-11 cursor-pointer text-lg font-bold">Block some time</summary>
          <form action={createBlockAction} className="mt-3">
            <input type="hidden" name="venueId" value={venue.id} />
            <input type="hidden" name="back" value={back} />
            <Field label="Where" htmlFor="blk-room">
              <Select
                id="blk-room"
                name="roomId"
                options={[{ value: "all", label: "Whole venue" }, ...rooms.map((r) => ({ value: r.id, label: r.name }))]}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start date" htmlFor="blk-sd">
                <Input id="blk-sd" name="startDate" type="date" min={today} defaultValue={today} required />
              </Field>
              <Field label="Start time" htmlFor="blk-st">
                <Input id="blk-st" name="startTime" type="time" step={300} required />
              </Field>
              <Field label="End date" htmlFor="blk-ed">
                <Input id="blk-ed" name="endDate" type="date" min={today} defaultValue={today} required />
              </Field>
              <Field label="End time" htmlFor="blk-et">
                <Input id="blk-et" name="endTime" type="time" step={300} required />
              </Field>
            </div>
            <Field label="Reason" htmlFor="blk-reason">
              <Select
                id="blk-reason"
                name="reasonChoice"
                defaultValue="private_hire"
                options={[
                  { value: "closed", label: "Closed" },
                  { value: "private_hire", label: "Private hire" },
                  { value: "other", label: "Something else (type it below)" },
                ]}
              />
            </Field>
            <Field label="Something else" htmlFor="blk-other" optional>
              <Input id="blk-other" name="reasonOther" maxLength={200} placeholder="e.g. Staff training" />
            </Field>
            <Button type="submit" block>
              Block this time
            </Button>
          </form>
        </details>
      ) : null}
    </>
  );
}
