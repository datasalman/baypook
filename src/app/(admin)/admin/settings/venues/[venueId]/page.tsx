import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { asc, count, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { WEEKDAY_KEYS, localDate, localTime } from "@/core/time";
import { isUuid } from "@/server/catalogue";
import { roleAt } from "@/server/auth";
import { getAdminContext } from "@/server/venue-scope";
import { Badge, Banner, Button, Checkbox, ConfirmButton, Field, Input, PageHeader, SectionTitle, Select, Textarea } from "@/components/ui";
import { addRoomAction, deleteRoomAction, renameRoomAction, saveVenueAction } from "../../actions";
import { minutesToHoursField, WEEKDAY_LONG, WEEKDAY_ORDER } from "../../../catalogue/_lib/venue";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Venue settings" };

export default async function VenueSettingsPage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = await params;
  const ctx = await getAdminContext();
  if (!isUuid(venueId)) notFound();
  const venue = ctx.venues.find((v) => v.id === venueId);
  const role = venue ? roleAt(ctx.user, venue.id) : null;
  // Owner edits; a manager of this venue reads; anyone else gets "not found".
  if (!venue || (role !== "owner" && role !== "manager")) notFound();
  const canEdit = role === "owner";
  const tz = ctx.org.timezone;

  const rooms = await ctx.db.select().from(s.rooms).where(eq(s.rooms.venueId, venue.id)).orderBy(asc(s.rooms.sortOrder), asc(s.rooms.name));
  const usage = await Promise.all(
    rooms.map(async (r) => {
      const [[a], [b]] = await Promise.all([
        ctx.db.select({ n: count() }).from(s.services).where(eq(s.services.roomId, r.id)),
        ctx.db.select({ n: count() }).from(s.bookings).where(eq(s.bookings.roomId, r.id)),
      ]);
      return { id: r.id, services: Number(a.n), bookings: Number(b.n) };
    }),
  );
  const back = `/admin/settings/venues/${venue.id}`;

  return (
    <>
      <PageHeader
        back={{ href: "/admin/settings", label: "Settings" }}
        title={venue.name}
        subtitle={canEdit ? "Venue details, opening hours and booking policy" : "Venue details (only the owner can change them)"}
      />
      {!venue.openingHoursConfirmed ? <Banner className="mb-4">The opening hours are placeholders. Check them, tick Confirmed and save.</Banner> : null}

      <form action={saveVenueAction} className="rounded-2xl border border-line bg-surface p-4">
        <input type="hidden" name="venueId" value={venue.id} />
        <input type="hidden" name="back" value={back} />
        <fieldset disabled={!canEdit} className="min-w-0">
          <Field label="Venue name" htmlFor="v-name">
            <Input id="v-name" name="name" defaultValue={venue.name} required maxLength={120} />
          </Field>
          <div className="grid gap-x-3 sm:grid-cols-3">
            <Field label="Status" htmlFor="v-status" hint="Closed: not bookable" className="sm:col-span-1">
              <Select
                id="v-status"
                name="status"
                defaultValue={venue.status}
                options={[
                  { value: "open", label: "Open" },
                  { value: "opening", label: "Opening soon" },
                  { value: "closed", label: "Closed" },
                ]}
              />
            </Field>
            <Field label="Opens on" htmlFor="v-opens-date" optional hint="No bookings before this">
              <Input id="v-opens-date" name="opensAtDate" type="date" defaultValue={venue.opensAt ? localDate(venue.opensAt, tz) : ""} />
            </Field>
            <Field label="at" htmlFor="v-opens-time" optional>
              <Input id="v-opens-time" name="opensAtTime" type="time" step={300} defaultValue={venue.opensAt ? localTime(venue.opensAt, tz) : "10:00"} />
            </Field>
          </div>

          <h3 className="mb-2 mt-2 font-bold">Address and getting here</h3>
          <Field label="Address" htmlFor="v-address">
            <Textarea id="v-address" name="address" defaultValue={venue.address} rows={2} required maxLength={500} />
          </Field>
          <div className="grid gap-x-3 sm:grid-cols-2">
            <Field label="Postcode" htmlFor="v-postcode" optional>
              <Input id="v-postcode" name="postcode" defaultValue={venue.postcode ?? ""} maxLength={20} />
            </Field>
            <Field label="Map link" htmlFor="v-maps" optional>
              <Input id="v-maps" name="mapsUrl" type="url" defaultValue={venue.mapsUrl ?? ""} placeholder="https://maps.google.com/…" />
            </Field>
          </div>
          <Field label="Parking" htmlFor="v-parking" optional hint="Goes in the confirmation email.">
            <Textarea id="v-parking" name="parkingNotes" defaultValue={venue.parkingNotes ?? ""} rows={2} maxLength={1000} />
          </Field>
          <Field label="Getting here" htmlFor="v-transport" optional>
            <Textarea id="v-transport" name="transportNotes" defaultValue={venue.transportNotes ?? ""} rows={2} maxLength={1000} />
          </Field>
          <Field label="Google Calendar ID" htmlFor="v-gcal" optional hint="Bookings are copied to this calendar. See Connections for setting it up.">
            <Input id="v-gcal" name="googleCalendarId" defaultValue={venue.googleCalendarId ?? ""} maxLength={300} placeholder="…@group.calendar.google.com" />
          </Field>

          <h3 className="mb-1 mt-2 font-bold">
            Opening hours {!venue.openingHoursConfirmed ? <Badge tone="amber">Placeholder: please confirm</Badge> : null}
          </h3>
          <p className="mb-2 text-sm text-muted">Party start times fit inside these hours. Workshop times come from each timetable.</p>
          <div className="mb-3 divide-y divide-line rounded-xl border border-line">
            {WEEKDAY_ORDER.map((w) => {
              const key = WEEKDAY_KEYS[w];
              const h = venue.openingHours[key];
              return (
                <div key={key} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="w-24 font-semibold">{WEEKDAY_LONG[w]}</span>
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input type="checkbox" name={`${key}.closed`} defaultChecked={!h} className="h-5 w-5 accent-[var(--brand-strong)]" />
                    Closed
                  </label>
                  <label className="sr-only" htmlFor={`v-${key}-open`}>
                    {WEEKDAY_LONG[w]} opens
                  </label>
                  <Input id={`v-${key}-open`} name={`${key}.open`} type="time" step={300} defaultValue={h?.open ?? "10:00"} className="w-32" />
                  <span aria-hidden>to</span>
                  <label className="sr-only" htmlFor={`v-${key}-close`}>
                    {WEEKDAY_LONG[w]} closes
                  </label>
                  <Input id={`v-${key}-close`} name={`${key}.close`} type="time" step={300} defaultValue={h?.close ?? "18:00"} className="w-32" />
                </div>
              );
            })}
          </div>
          <Checkbox name="openingHoursConfirmed" defaultChecked={venue.openingHoursConfirmed} label="Confirmed" hint="Tick when these are the real hours." />

          <h3 className="mb-2 mt-2 font-bold">Booking policy</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Most places per booking" htmlFor="v-max">
              <Input id="v-max" name="maxPlacesPerBooking" type="number" inputMode="numeric" min={1} max={200} defaultValue={venue.maxPlacesPerBooking} required />
            </Field>
            <Field label="Order in lists" htmlFor="v-sort">
              <Input id="v-sort" name="sortOrder" type="number" inputMode="numeric" min={0} max={1000} defaultValue={venue.sortOrder} required />
            </Field>
            <Field label="Default notice (hours)" htmlFor="v-lead" hint="For new services">
              <Input
                id="v-lead"
                name="defaultLeadTimeHours"
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                defaultValue={minutesToHoursField(venue.defaultLeadTimeMinutes)}
                required
              />
            </Field>
            <Field label="Default cut-off (minutes)" htmlFor="v-cutoff" hint="For new services">
              <Input id="v-cutoff" name="defaultCutoffMinutes" type="number" inputMode="numeric" min={0} step={5} defaultValue={venue.defaultCutoffMinutes} required />
            </Field>
          </div>
          {canEdit ? (
            <Button type="submit" block>
              Save {venue.name}
            </Button>
          ) : null}
        </fieldset>
      </form>

      <section id="rooms" className="scroll-mt-16">
        <SectionTitle>Rooms</SectionTitle>
        <p className="mb-2 text-sm text-muted">A party blocks workshops in the same room. Separate rooms do not block each other.</p>
        <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
          {rooms.map((r) => {
            const u = usage.find((x) => x.id === r.id);
            const inUse = (u?.services ?? 0) > 0 || (u?.bookings ?? 0) > 0;
            return (
              <li key={r.id} className="flex flex-wrap items-end gap-2 px-4 py-3">
                {canEdit ? (
                  <form action={renameRoomAction} className="flex min-w-0 flex-1 items-end gap-2">
                    <input type="hidden" name="roomId" value={r.id} />
                    <input type="hidden" name="back" value={`${back}#rooms`} />
                    <Field label="Room name" htmlFor={`room-${r.id}`} className="mb-0 flex-1">
                      <Input id={`room-${r.id}`} name="name" defaultValue={r.name} required maxLength={80} />
                    </Field>
                    <Button type="submit" variant="secondary">
                      Rename
                    </Button>
                  </form>
                ) : (
                  <span className="flex-1 font-semibold">{r.name}</span>
                )}
                <span className="text-sm text-muted">
                  {u?.services ?? 0} {u?.services === 1 ? "service" : "services"}
                </span>
                {canEdit && !inUse && rooms.length > 1 ? (
                  <form action={deleteRoomAction}>
                    <input type="hidden" name="roomId" value={r.id} />
                    <input type="hidden" name="back" value={`${back}#rooms`} />
                    <ConfirmButton size="sm" variant="ghost" prompt={`Remove ${r.name}?`} confirmLabel="Remove">
                      Remove
                    </ConfirmButton>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
        {canEdit ? (
          <form action={addRoomAction} className="mt-3 flex items-end gap-2">
            <input type="hidden" name="venueId" value={venue.id} />
            <input type="hidden" name="back" value={`${back}#rooms`} />
            <Field label="New room" htmlFor="room-new" className="mb-0 flex-1">
              <Input id="room-new" name="name" required maxLength={80} placeholder="e.g. Party room" />
            </Field>
            <Button type="submit">Add room</Button>
          </form>
        ) : null}
      </section>
    </>
  );
}
