import type * as s from "@/db/schema";
import { fmtDayShort, zonedDateTime } from "@/core/time";
import type { ServiceWithCatalogue } from "@/server/catalogue";
import { EXCEPTION_KINDS } from "@/server/catalogue-admin";
import { Badge, Button, ConfirmButton, EmptyState, Field, Input, SectionTitle, Select } from "@/components/ui";
import { addExceptionAction, deleteExceptionAction } from "../../actions";

function describe(e: s.TimetableException): { label: string; tone: "red" | "green" | "blue" } {
  if (e.kind === "cancel") return { label: e.startTime ? `Cancelled at ${e.startTime}` : "Whole day cancelled", tone: "red" };
  if (e.kind === "add") return { label: `Extra session at ${e.startTime}${e.capacity ? `, ${e.capacity} places` : ""}`, tone: "green" };
  return { label: `${e.capacity} places at ${e.startTime}`, tone: "blue" };
}

export function ExceptionsSection({
  service: svc,
  exceptions,
  today,
  canManage,
  back,
}: {
  service: ServiceWithCatalogue;
  exceptions: s.TimetableException[];
  today: string;
  canManage: boolean;
  back: string;
}) {
  return (
    <section id="changes" className="scroll-mt-36">
      <SectionTitle>One-off changes</SectionTitle>
      <p className="mb-3 text-sm text-muted">For one day only: cancel, add a session or change the places. The weekly timetable stays as it is.</p>
      {exceptions.length ? (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {exceptions.map((e) => {
            const d = describe(e);
            return (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <span className="min-w-0">
                  <span className="block font-semibold">{fmtDayShort(zonedDateTime(e.date, "12:00"))}</span>
                  <Badge tone={d.tone}>{d.label}</Badge>
                  {e.note ? <span className="mt-1 block text-sm text-muted">{e.note}</span> : null}
                </span>
                {canManage ? (
                  <form action={deleteExceptionAction}>
                    <input type="hidden" name="exceptionId" value={e.id} />
                    <input type="hidden" name="back" value={back} />
                    <ConfirmButton size="sm" variant="ghost" prompt="Remove this change? The usual timetable applies again." confirmLabel="Remove">
                      Remove
                    </ConfirmButton>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState title="No changes coming up">The weekly timetable applies every day.</EmptyState>
      )}

      {canManage ? (
        <details className="mt-3 rounded-2xl border border-dashed border-line bg-surface p-4">
          <summary className="min-h-11 cursor-pointer font-bold">Add a one-off change</summary>
          <form action={addExceptionAction} className="mt-3">
            <input type="hidden" name="serviceId" value={svc.id} />
            <input type="hidden" name="back" value={back} />
            <Field label="Date" htmlFor="ex-date">
              <Input id="ex-date" name="date" type="date" min={today} defaultValue={today} required />
            </Field>
            <Field label="What" htmlFor="ex-kind">
              <Select id="ex-kind" name="kind" options={Object.entries(EXCEPTION_KINDS).map(([value, label]) => ({ value, label }))} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Time" htmlFor="ex-time" hint="Not needed to cancel the whole day">
                <Input id="ex-time" name="startTime" type="time" step={300} />
              </Field>
              <Field label="Places" htmlFor="ex-cap" hint="For adding or changing places">
                <Input id="ex-cap" name="capacity" type="number" inputMode="numeric" min={0} max={500} />
              </Field>
            </div>
            <Field label="Note" htmlFor="ex-note" optional hint="Only staff see this">
              <Input id="ex-note" name="note" maxLength={300} />
            </Field>
            <Button type="submit" block>
              Save change
            </Button>
          </form>
        </details>
      ) : null}
    </section>
  );
}
