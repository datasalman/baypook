import type * as s from "@/db/schema";
import type { ServiceWithCatalogue } from "@/server/catalogue";
import { Button, Checkbox, ConfirmButton, Field, Input, SectionTitle, Select, Textarea } from "@/components/ui";
import { setServiceArchivedAction, updateServiceAction } from "../../actions";
import { minutesToHoursField } from "../../_lib/venue";

export function DetailsSection({
  service: svc,
  rooms,
  canManage,
  back,
}: {
  service: ServiceWithCatalogue;
  rooms: s.Room[];
  canManage: boolean;
  back: string;
}) {
  const isSlot = svc.kind === "slot";
  return (
    <section id="details" className="scroll-mt-16">
      <SectionTitle>Details</SectionTitle>
      <form action={updateServiceAction} className="rounded-2xl border border-line bg-surface p-4">
        <input type="hidden" name="serviceId" value={svc.id} />
        <input type="hidden" name="kind" value={svc.kind} />
        <input type="hidden" name="back" value={back} />
        <fieldset disabled={!canManage} className="min-w-0">
          <Field label="Name" htmlFor="svc-name">
            <Input id="svc-name" name="name" defaultValue={svc.name} required maxLength={120} />
          </Field>
          <Field label="Description" htmlFor="svc-blurb" optional hint="Shown to customers under the name.">
            <Textarea id="svc-blurb" name="blurb" defaultValue={svc.blurb ?? ""} rows={3} maxLength={1000} />
          </Field>
          <Field label="Room" htmlFor="svc-room" hint="Bookings in the same room cannot overlap a party.">
            <Select id="svc-room" name="roomId" defaultValue={svc.roomId} options={rooms.map((r) => ({ value: r.id, label: r.name }))} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Length (minutes)" htmlFor="svc-length">
              <Input id="svc-length" name="lengthMinutes" type="number" inputMode="numeric" min={5} max={1440} step={5} defaultValue={svc.lengthMinutes} required />
            </Field>
            {isSlot ? (
              <Field label="Start times every (minutes)" htmlFor="svc-interval">
                <Input
                  id="svc-interval"
                  name="slotIntervalMinutes"
                  type="number"
                  inputMode="numeric"
                  min={5}
                  max={240}
                  step={5}
                  defaultValue={svc.slotIntervalMinutes}
                  required
                />
              </Field>
            ) : null}
            <Field label="Notice needed (hours)" htmlFor="svc-lead" hint="0 for none; 48 for two days">
              <Input
                id="svc-lead"
                name="leadTimeHours"
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                defaultValue={minutesToHoursField(svc.leadTimeMinutes)}
                required
              />
            </Field>
            <Field label="Booking closes (minutes before)" htmlFor="svc-cutoff" hint="0 means up to the start">
              <Input id="svc-cutoff" name="cutoffMinutes" type="number" inputMode="numeric" min={0} step={5} defaultValue={svc.cutoffMinutes} required />
            </Field>
          </div>
          <Checkbox name="onlineEnabled" defaultChecked={svc.onlineEnabled} label="Bookable online" hint="Off hides it from the booking page; you can still add bookings here." />
          <Checkbox
            name="payInStoreEnabled"
            defaultChecked={svc.payInStoreEnabled}
            label="Pay in store"
            hint="Bookings confirm without paying online and show as owed."
          />
          <details className="mb-4 rounded-xl border border-line p-3">
            <summary className="min-h-11 cursor-pointer font-semibold">In-store note</summary>
            <p className="mb-3 mt-1 text-sm text-muted">For things paid on the day, shown under the total. Notes about one option go on that option.</p>
            <Field label="Line beside the price" htmlFor="svc-note-line" optional>
              <Input id="svc-note-line" name="inStoreNoteLine" defaultValue={svc.inStoreNoteLine ?? ""} maxLength={300} />
            </Field>
            <Field label="Short note (emails)" htmlFor="svc-note-short" optional>
              <Input id="svc-note-short" name="inStoreNoteShort" defaultValue={svc.inStoreNoteShort ?? ""} maxLength={300} />
            </Field>
            <Field label="Menu link" htmlFor="svc-note-url" optional>
              <Input id="svc-note-url" name="inStoreMenuUrl" type="url" defaultValue={svc.inStoreMenuUrl ?? ""} placeholder="https://" />
            </Field>
          </details>
          <Field label="Colour" htmlFor="svc-colour" hint="Used on the calendar">
            <Input id="svc-colour" name="colour" type="color" defaultValue={svc.colour} className="max-w-32" />
          </Field>
          {canManage ? (
            <Button type="submit" block>
              Save details
            </Button>
          ) : null}
        </fieldset>
      </form>

      {canManage ? (
        <form action={setServiceArchivedAction} className="mt-3">
          <input type="hidden" name="serviceId" value={svc.id} />
          <input type="hidden" name="back" value={back} />
          {svc.archivedAt ? (
            <Button type="submit" name="archived" value="0" variant="secondary" block>
              Restore this service
            </Button>
          ) : (
            <ConfirmButton
              name="archived"
              value="1"
              variant="secondary"
              block
              prompt="Archive it? It disappears from booking. Existing bookings stay."
              confirmLabel="Yes, archive"
            >
              Archive this service
            </ConfirmButton>
          )}
        </form>
      ) : null}
    </section>
  );
}
