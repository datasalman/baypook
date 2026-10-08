import type * as s from "@/db/schema";
import { WEEKDAY_KEYS } from "@/core/time";
import type { ServiceWithCatalogue } from "@/server/catalogue";
import { hourlyStarts } from "@/server/catalogue-admin";
import { Button, ConfirmButton, EmptyState, Field, Input, SectionTitle } from "@/components/ui";
import { addRulesAction, deleteRuleAction, fillRulesAction, updateRuleAction } from "../../actions";
import { WEEKDAY_LONG, WEEKDAY_ORDER, WEEKDAY_SHORT } from "../../_lib/venue";

function validity(r: s.TimetableRule): string {
  if (r.validFrom && r.validTo) return `${r.validFrom} to ${r.validTo}`;
  if (r.validFrom) return `from ${r.validFrom}`;
  if (r.validTo) return `until ${r.validTo}`;
  return "";
}

export function TimetableSection({
  service: svc,
  venue,
  rules,
  canManage,
  back,
}: {
  service: ServiceWithCatalogue;
  venue: s.Venue;
  rules: s.TimetableRule[];
  canManage: boolean;
  back: string;
}) {
  const times = Array.from(new Set(rules.map((r) => r.startTime))).sort();
  const cell = (weekday: number, time: string) => rules.filter((r) => r.weekday === weekday && r.startTime === time);
  const fillCount = WEEKDAY_ORDER.reduce<number>(
    (n, w) => n + hourlyStarts(venue.openingHours[WEEKDAY_KEYS[w]], svc.lengthMinutes).filter((t) => !rules.some((r) => r.weekday === w && r.startTime === t)).length,
    0,
  );
  const typicalCap = rules[0]?.capacity ?? 10;

  return (
    <section id="timetable" className="scroll-mt-36">
      <SectionTitle aside={`${rules.length} ${rules.length === 1 ? "time" : "times"} a week`}>Timetable</SectionTitle>
      <p className="mb-3 text-sm text-muted">Each cell is the places at that start time. Changes show on the calendar straight away.</p>

      {times.length ? (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
          <table className="w-full border-collapse text-center text-sm tabular-nums">
            <caption className="sr-only">Start times by weekday, with places</caption>
            <thead>
              <tr className="border-b border-line bg-canvas">
                <th scope="col" className="px-1 py-2 text-left font-semibold">
                  Time
                </th>
                {WEEKDAY_ORDER.map((w) => (
                  <th key={w} scope="col" className="px-1 py-2 font-semibold">
                    <abbr title={WEEKDAY_LONG[w]} className="no-underline">
                      {WEEKDAY_SHORT[w]}
                    </abbr>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {times.map((t) => (
                <tr key={t} className="border-b border-line last:border-0">
                  <th scope="row" className="px-1 py-2 text-left font-semibold">
                    {t}
                  </th>
                  {WEEKDAY_ORDER.map((w) => {
                    const rs = cell(w, t);
                    const limited = rs.some((r) => r.validFrom || r.validTo);
                    return (
                      <td key={w} className={rs.length ? "px-1 py-2 font-semibold text-ink" : "px-1 py-2 text-muted"}>
                        {rs.length ? (
                          <span title={rs.map((r) => `${r.capacity} places ${validity(r)}`.trim()).join("; ")}>
                            {rs.map((r) => r.capacity).join("/")}
                            {limited ? (
                              <>
                                <sup aria-hidden="true">*</sup>
                                <span className="sr-only"> (only between certain dates)</span>
                              </>
                            ) : null}
                          </span>
                        ) : (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="sr-only">None</span>
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="No times yet">Add times below, or fill them from the venue&apos;s opening hours.</EmptyState>
      )}
      {rules.some((r) => r.validFrom || r.validTo) ? <p className="mt-1 text-sm text-muted">
          <span aria-hidden="true">* </span>Only between certain dates.
        </p> : null}

      {rules.length ? (
        <details className="mt-3 rounded-2xl border border-line bg-surface p-4">
          <summary className="min-h-11 cursor-pointer font-bold">{canManage ? "Change or remove times" : "All times"}</summary>
          {WEEKDAY_ORDER.map((w) => {
            const dayRules = rules.filter((r) => r.weekday === w).sort((a, b) => a.startTime.localeCompare(b.startTime));
            if (!dayRules.length) return null;
            return (
              <div key={w} className="mt-3">
                <h3 className="mb-1 font-bold">{WEEKDAY_LONG[w]}</h3>
                <ul className="divide-y divide-line">
                  {dayRules.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
                      <span className="w-14 font-semibold tabular-nums">{r.startTime}</span>
                      {canManage ? (
                        <>
                          <form action={updateRuleAction} className="flex items-center gap-2">
                            <input type="hidden" name="ruleId" value={r.id} />
                            <input type="hidden" name="back" value={back} />
                            <label className="sr-only" htmlFor={`rule-cap-${r.id}`}>
                              Places at {r.startTime} on {WEEKDAY_LONG[w]}
                            </label>
                            <Input id={`rule-cap-${r.id}`} name="capacity" type="number" inputMode="numeric" min={1} max={500} defaultValue={r.capacity} className="w-20" required />
                            <Button type="submit" variant="secondary" size="sm">
                              Save
                            </Button>
                          </form>
                          <form action={deleteRuleAction}>
                            <input type="hidden" name="ruleId" value={r.id} />
                            <input type="hidden" name="back" value={back} />
                            <ConfirmButton size="sm" variant="ghost" prompt={`Remove ${WEEKDAY_LONG[w]} ${r.startTime}?`} confirmLabel="Remove">
                              Remove
                            </ConfirmButton>
                          </form>
                        </>
                      ) : (
                        <span>{r.capacity} places</span>
                      )}
                      {validity(r) ? <span className="text-sm text-muted">{validity(r)}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </details>
      ) : null}

      {canManage ? (
        <>
          <details className="mt-3 rounded-2xl border border-dashed border-line bg-surface p-4" open={rules.length === 0}>
            <summary className="min-h-11 cursor-pointer font-bold">Add times</summary>
            <form action={addRulesAction} className="mt-3">
              <input type="hidden" name="serviceId" value={svc.id} />
              <input type="hidden" name="back" value={back} />
              <fieldset className="mb-4">
                <legend className="mb-1 text-base font-semibold">Days</legend>
                <div className="flex flex-wrap gap-2">
                  {WEEKDAY_ORDER.map((w) => (
                    <label
                      key={w}
                      className="flex min-h-11 min-w-14 cursor-pointer items-center justify-center gap-1 rounded-xl border-2 border-line bg-surface px-2 font-semibold has-[:checked]:border-brand-strong has-[:checked]:bg-brand-soft"
                    >
                      <input type="checkbox" name="weekdays" value={w} className="h-5 w-5 accent-[var(--brand-strong)]" />
                      {WEEKDAY_SHORT[w]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Start time" htmlFor="rule-start">
                  <Input id="rule-start" name="startTime" type="time" step={300} required />
                </Field>
                <Field label="Places" htmlFor="rule-cap">
                  <Input id="rule-cap" name="capacity" type="number" inputMode="numeric" min={1} max={500} defaultValue={typicalCap} required />
                </Field>
                <Field label="From" htmlFor="rule-from" optional>
                  <Input id="rule-from" name="validFrom" type="date" />
                </Field>
                <Field label="Until" htmlFor="rule-to" optional>
                  <Input id="rule-to" name="validTo" type="date" />
                </Field>
              </div>
              <Button type="submit" block>
                Add times
              </Button>
            </form>
          </details>

          <form action={fillRulesAction} className="mt-3 rounded-2xl border border-line bg-surface p-4">
            <input type="hidden" name="serviceId" value={svc.id} />
            <input type="hidden" name="back" value={back} />
            <p className="mb-2 font-bold">Fill from opening hours</p>
            <p className="mb-3 text-sm text-muted">
              Adds a start every hour from opening until {svc.lengthMinutes} minutes before closing, on every open day. Nothing is replaced; only missing
              times are added ({fillCount} at the moment).
            </p>
            <Field label="Places for the new times" htmlFor="fill-cap">
              <Input id="fill-cap" name="capacity" type="number" inputMode="numeric" min={1} max={500} defaultValue={typicalCap} required className="max-w-32" />
            </Field>
            <ConfirmButton
              variant="secondary"
              block
              disabled={fillCount === 0}
              prompt={`Add ${fillCount} ${fillCount === 1 ? "time" : "times"} from ${venue.name}'s opening hours?`}
              confirmLabel="Yes, add them"
            >
              Fill from opening hours
            </ConfirmButton>
          </form>
        </>
      ) : null}
    </section>
  );
}
