import type * as s from "@/db/schema";
import { fmtPence } from "@/core/time";
import type { ServiceWithCatalogue } from "@/server/catalogue";
import { penceToPounds } from "@/server/catalogue-admin";
import { Badge, Button, Card, Field, Input, SectionTitle, Textarea } from "@/components/ui";
import { createOptionAction, setOptionArchivedAction, updateOptionAction } from "../../actions";

function OptionFields({ option, isSlot, idPrefix }: { option?: s.ServiceOption; isSlot: boolean; idPrefix: string }) {
  const id = (k: string) => `${idPrefix}-${k}`;
  return (
    <>
      <Field label="Name" htmlFor={id("name")}>
        <Input id={id("name")} name="name" defaultValue={option?.name ?? ""} required maxLength={120} />
      </Field>
      <Field label="Description" htmlFor={id("blurb")} optional>
        <Textarea id={id("blurb")} name="blurb" defaultValue={option?.blurb ?? ""} rows={2} maxLength={1000} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={isSlot ? "Package price (£)" : "Price per place (£)"} htmlFor={id("price")}>
          <div className="flex items-center gap-1">
            <span aria-hidden className="text-lg font-semibold">
              £
            </span>
            <Input
              id={id("price")}
              name="price"
              inputMode="decimal"
              pattern="[0-9]+([.][0-9]{1,2})?"
              title="A price like 17 or 17.50"
              defaultValue={option ? penceToPounds(option.unitPricePence) : ""}
              required
            />
          </div>
        </Field>
        {isSlot ? (
          <Field label="Children included" htmlFor={id("included")}>
            <Input id={id("included")} name="includedChildren" type="number" inputMode="numeric" min={1} max={200} defaultValue={option?.includedChildren ?? ""} />
          </Field>
        ) : null}
        <Field label="Most per booking" htmlFor={id("max")} optional hint="Empty: no limit beyond the venue's">
          <Input id={id("max")} name="maxPerBooking" type="number" inputMode="numeric" min={1} max={200} defaultValue={option?.maxPerBooking ?? ""} />
        </Field>
      </div>
      <details className="mb-4 rounded-xl border border-line p-3">
        <summary className="min-h-11 cursor-pointer font-semibold">In-store note</summary>
        <Field label="Line beside the price" htmlFor={id("note-line")} optional className="mt-2">
          <Input id={id("note-line")} name="inStoreNoteLine" defaultValue={option?.inStoreNoteLine ?? ""} maxLength={300} />
        </Field>
        <Field label="Short note (emails)" htmlFor={id("note-short")} optional>
          <Input id={id("note-short")} name="inStoreNoteShort" defaultValue={option?.inStoreNoteShort ?? ""} maxLength={300} />
        </Field>
        <Field label="Menu link" htmlFor={id("note-url")} optional>
          <Input id={id("note-url")} name="inStoreMenuUrl" type="url" defaultValue={option?.inStoreMenuUrl ?? ""} placeholder="https://" />
        </Field>
      </details>
    </>
  );
}

export function OptionsSection({ service: svc, canManage, back }: { service: ServiceWithCatalogue; canManage: boolean; back: string }) {
  const isSlot = svc.kind === "slot";
  const live = svc.options.filter((o) => !o.archivedAt);
  const archived = svc.options.filter((o) => o.archivedAt);
  return (
    <section id="options" className="scroll-mt-36">
      <SectionTitle aside={isSlot ? "One package per party" : "Each place is one child"}>{isSlot ? "Package" : "Options and prices"}</SectionTitle>
      <ul className="flex flex-col gap-2">
        {live.map((o) => (
          <Card key={o.id} as="li">
            <details>
              <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="block font-bold">{o.name}</span>
                  <span className="block text-sm text-muted">
                    {fmtPence(o.unitPricePence)}
                    {isSlot ? ` for ${o.includedChildren ?? "?"} children` : " a place"}
                    {o.maxPerBooking ? ` · up to ${o.maxPerBooking} per booking` : ""}
                    {o.inStoreNoteLine ? ` · ${o.inStoreNoteLine}` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-sm font-semibold text-brand-strong">{canManage ? "Edit" : "View"}</span>
              </summary>
              <form action={updateOptionAction} className="mt-3">
                <input type="hidden" name="optionId" value={o.id} />
                <input type="hidden" name="back" value={back} />
                <fieldset disabled={!canManage} className="min-w-0">
                  <OptionFields option={o} isSlot={isSlot} idPrefix={`opt-${o.id}`} />
                  {canManage ? (
                    <Button type="submit" block>
                      Save {o.name}
                    </Button>
                  ) : null}
                </fieldset>
              </form>
              {canManage ? (
                <form action={setOptionArchivedAction} className="mt-2">
                  <input type="hidden" name="optionId" value={o.id} />
                  <input type="hidden" name="archived" value="1" />
                  <input type="hidden" name="back" value={back} />
                  <Button type="submit" variant="ghost" block>
                    Archive {o.name}
                  </Button>
                </form>
              ) : null}
            </details>
          </Card>
        ))}
      </ul>

      {archived.length ? (
        <details className="mt-2">
          <summary className="min-h-11 cursor-pointer text-sm font-semibold text-muted">Archived ({archived.length})</summary>
          <ul className="mt-1 flex flex-col gap-2">
            {archived.map((o) => (
              <Card key={o.id} as="li" tone="muted">
                <div className="flex items-center justify-between gap-2">
                  <span>
                    <span className="font-semibold text-ink">{o.name}</span> · {fmtPence(o.unitPricePence)} <Badge tone="grey">Archived</Badge>
                  </span>
                  {canManage ? (
                    <form action={setOptionArchivedAction}>
                      <input type="hidden" name="optionId" value={o.id} />
                      <input type="hidden" name="archived" value="0" />
                      <input type="hidden" name="back" value={back} />
                      <Button type="submit" variant="secondary" size="sm">
                        Restore
                      </Button>
                    </form>
                  ) : null}
                </div>
              </Card>
            ))}
          </ul>
        </details>
      ) : null}

      {canManage && (!isSlot || live.length === 0) ? (
        <details className="mt-3 rounded-2xl border border-dashed border-line bg-surface p-4">
          <summary className="min-h-11 cursor-pointer font-bold">{isSlot ? "Add the package" : "Add an option"}</summary>
          <form action={createOptionAction} className="mt-3">
            <input type="hidden" name="serviceId" value={svc.id} />
            <input type="hidden" name="back" value={back} />
            <OptionFields isSlot={isSlot} idPrefix="opt-new" />
            <Button type="submit" block>
              Add
            </Button>
          </form>
        </details>
      ) : null}
    </section>
  );
}
