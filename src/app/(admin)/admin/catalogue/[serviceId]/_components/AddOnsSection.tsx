import type * as s from "@/db/schema";
import { fmtPence } from "@/core/time";
import type { ServiceWithCatalogue } from "@/server/catalogue";
import { penceToPounds } from "@/server/catalogue-admin";
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, SectionTitle, Select, Textarea } from "@/components/ui";
import { createAddOnAction, setAddOnArchivedAction, updateAddOnAction } from "../../actions";

function AddOnFields({ addOn, idPrefix }: { addOn?: s.AddOn; idPrefix: string }) {
  const id = (k: string) => `${idPrefix}-${k}`;
  return (
    <>
      <Field label="Name" htmlFor={id("name")}>
        <Input id={id("name")} name="name" defaultValue={addOn?.name ?? ""} required maxLength={120} placeholder="e.g. Extra child" />
      </Field>
      <Field label="Description" htmlFor={id("blurb")} optional>
        <Textarea id={id("blurb")} name="blurb" defaultValue={addOn?.blurb ?? ""} rows={2} maxLength={1000} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Price each (£)" htmlFor={id("price")}>
          <div className="flex items-center gap-1">
            <span aria-hidden className="text-lg font-semibold">
              £
            </span>
            <Input
              id={id("price")}
              name="price"
              inputMode="decimal"
              pattern="[0-9]+([.][0-9]{1,2})?"
              title="A price like 16 or 16.50"
              defaultValue={addOn ? penceToPounds(addOn.pricePence) : ""}
              required
            />
          </div>
        </Field>
        <Field label="Most per booking" htmlFor={id("max")}>
          <Input id={id("max")} name="maxQuantity" type="number" inputMode="numeric" min={1} max={200} defaultValue={addOn?.maxQuantity ?? 1} required />
        </Field>
        <Field label="Kind" htmlFor={id("kind")}>
          <Select
            id={id("kind")}
            name="kind"
            defaultValue={addOn?.kind ?? "quantity"}
            options={[
              { value: "quantity", label: "Quantity" },
              { value: "time", label: "Extra time" },
            ]}
          />
        </Field>
        <Field label="Extra minutes" htmlFor={id("extra")} hint="Extra time only">
          <Input id={id("extra")} name="extraMinutes" type="number" inputMode="numeric" min={0} max={600} step={5} defaultValue={addOn?.extraMinutes ?? 0} />
        </Field>
      </div>
      <Checkbox name="perChild" defaultChecked={addOn?.perChild ?? false} label="Each one is an extra child" hint="Counts towards the party's children beyond the package." />
    </>
  );
}

export function AddOnsSection({ service: svc, canManage, back }: { service: ServiceWithCatalogue; canManage: boolean; back: string }) {
  const live = svc.addOns.filter((a) => !a.archivedAt);
  const archived = svc.addOns.filter((a) => a.archivedAt);
  return (
    <section id="addons" className="scroll-mt-36">
      <SectionTitle>Add-ons</SectionTitle>
      {live.length ? (
        <ul className="flex flex-col gap-2">
          {live.map((a) => (
            <Card key={a.id} as="li">
              <details>
                <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block font-bold">{a.name}</span>
                    <span className="block text-sm text-muted">
                      {fmtPence(a.pricePence)} each · up to {a.maxQuantity}
                      {a.kind === "time" ? ` · +${a.extraMinutes} min` : ""}
                      {a.perChild ? " · extra child" : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold text-brand-strong">{canManage ? "Edit" : "View"}</span>
                </summary>
                <form action={updateAddOnAction} className="mt-3">
                  <input type="hidden" name="addOnId" value={a.id} />
                  <input type="hidden" name="back" value={back} />
                  <fieldset disabled={!canManage} className="min-w-0">
                    <AddOnFields addOn={a} idPrefix={`addon-${a.id}`} />
                    {canManage ? (
                      <Button type="submit" block>
                        Save {a.name}
                      </Button>
                    ) : null}
                  </fieldset>
                </form>
                {canManage ? (
                  <form action={setAddOnArchivedAction} className="mt-2">
                    <input type="hidden" name="addOnId" value={a.id} />
                    <input type="hidden" name="archived" value="1" />
                    <input type="hidden" name="back" value={back} />
                    <Button type="submit" variant="ghost" block>
                      Archive {a.name}
                    </Button>
                  </form>
                ) : null}
              </details>
            </Card>
          ))}
        </ul>
      ) : (
        <EmptyState title="No add-ons">Extras such as an extra child or food time.</EmptyState>
      )}

      {archived.length ? (
        <details className="mt-2">
          <summary className="min-h-11 cursor-pointer text-sm font-semibold text-muted">Archived ({archived.length})</summary>
          <ul className="mt-1 flex flex-col gap-2">
            {archived.map((a) => (
              <Card key={a.id} as="li" tone="muted">
                <div className="flex items-center justify-between gap-2">
                  <span>
                    <span className="font-semibold text-ink">{a.name}</span> · {fmtPence(a.pricePence)} <Badge tone="grey">Archived</Badge>
                  </span>
                  {canManage ? (
                    <form action={setAddOnArchivedAction}>
                      <input type="hidden" name="addOnId" value={a.id} />
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

      {canManage ? (
        <details className="mt-3 rounded-2xl border border-dashed border-line bg-surface p-4">
          <summary className="min-h-11 cursor-pointer font-bold">Add an add-on</summary>
          <form action={createAddOnAction} className="mt-3">
            <input type="hidden" name="serviceId" value={svc.id} />
            <input type="hidden" name="back" value={back} />
            <AddOnFields idPrefix="addon-new" />
            <Button type="submit" block>
              Add
            </Button>
          </form>
        </details>
      ) : null}
    </section>
  );
}
