"use client";

import { useEffect, useMemo, useState } from "react";
import { PricingError, quote, type Quote } from "@/core/pricing";
import { fmtPence } from "@/core/time";
import { cn } from "@/components/ui/cn";

export type EditorOption = {
  id: string;
  name: string;
  blurb: string | null;
  unitPricePence: number;
  includedChildren: number | null;
  maxPerBooking: number | null;
  inStoreNoteShort: string | null;
};

export type EditorAddOn = {
  id: string;
  name: string;
  blurb: string | null;
  pricePence: number;
  kind: "quantity" | "time";
  extraMinutes: number;
  maxQuantity: number;
  perChild: boolean;
};

export type EditorCatalogue = {
  kind: "session" | "slot";
  options: EditorOption[];
  addOns: EditorAddOn[];
  maxPlacesPerBooking: number;
  serviceInStoreNoteShort: string | null;
};

export type QuantitiesEditorProps = {
  catalogue: EditorCatalogue;
  initialLines?: Record<string, number>;
  initialAddOns?: Record<string, number>;
  /** Sessions: places left at this time for this booking (caps the steppers). */
  placesLeft?: number | null;
  onQuote?: (q: Quote | null) => void;
};

function Stepper({
  id,
  label,
  hint,
  value,
  max,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string | null;
  value: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const btn =
    "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-2 border-line bg-surface text-2xl font-bold text-ink hover:border-ink/40 disabled:opacity-40";
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-3 last:border-b-0">
      <div className="min-w-0">
        <p id={`${id}-label`} className="text-base font-semibold">
          {label}
        </p>
        {hint ? <p className="text-sm text-muted">{hint}</p> : null}
      </div>
      <div className="flex items-center gap-2" role="group" aria-labelledby={`${id}-label`}>
        <button type="button" className={btn} aria-label={`Fewer: ${label}`} disabled={value <= 0} onClick={() => onChange(Math.max(0, value - 1))}>
          −
        </button>
        <output className="w-8 text-center text-xl font-bold tabular-nums" aria-live="polite">
          {value}
        </output>
        <button type="button" className={btn} aria-label={`More: ${label}`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
          +
        </button>
      </div>
    </div>
  );
}

/**
 * Places, package and extras for one service, with a live total from the same
 * pricing rules the server uses. Submits `line:<optionId>` and `addon:<addOnId>`
 * fields with its form. The server re-quotes; this total is only a preview.
 */
export function QuantitiesEditor({ catalogue, initialLines = {}, initialAddOns = {}, placesLeft, onQuote }: QuantitiesEditorProps) {
  const isSlot = catalogue.kind === "slot";
  const [lines, setLines] = useState<Record<string, number>>(() => {
    if (isSlot) {
      const chosen = catalogue.options.find((o) => (initialLines[o.id] ?? 0) > 0) ?? catalogue.options[0];
      return chosen ? { [chosen.id]: 1 } : {};
    }
    return { ...initialLines };
  });
  const [addOns, setAddOns] = useState<Record<string, number>>({ ...initialAddOns });
  // "Choose at least one place" only after someone has changed something, not on arrival.
  const [touched, setTouched] = useState(false);

  const result = useMemo((): { q: Quote | null; error: string | null } => {
    try {
      const q = quote({
        serviceKind: catalogue.kind,
        options: catalogue.options.map((o) => ({ ...o, archivedAt: null })),
        addOns: catalogue.addOns.map((a) => ({ ...a, archivedAt: null })),
        lines: Object.entries(lines)
          .filter(([, qty]) => qty > 0)
          .map(([optionId, qty]) => ({ optionId, qty })),
        addOnSelections: Object.entries(addOns)
          .filter(([, qty]) => qty > 0)
          .map(([addOnId, qty]) => ({ addOnId, qty })),
        maxPlacesPerBooking: catalogue.maxPlacesPerBooking,
        serviceInStoreNoteShort: catalogue.serviceInStoreNoteShort,
      });
      if (placesLeft !== null && placesLeft !== undefined && !isSlot && q.places > placesLeft) {
        return { q: null, error: `Only ${placesLeft} ${placesLeft === 1 ? "place" : "places"} left at this time.` };
      }
      return { q, error: null };
    } catch (e) {
      return { q: null, error: e instanceof PricingError ? e.message : "Check the places and extras." };
    }
  }, [catalogue, lines, addOns, placesLeft, isSlot]);

  useEffect(() => {
    onQuote?.(result.q);
  }, [result.q, onQuote]);

  const placesNow = Object.values(lines).reduce((n, v) => n + v, 0);
  const nothingChosen = !result.q && placesNow === 0;
  const sessionCap = Math.min(catalogue.maxPlacesPerBooking, placesLeft ?? Number.POSITIVE_INFINITY);

  return (
    <div>
      {isSlot ? (
        <fieldset className="mb-4">
          <legend className="mb-2 text-base font-bold">Package</legend>
          <div className="flex flex-col gap-2">
            {catalogue.options.map((o) => {
              const checked = (lines[o.id] ?? 0) > 0;
              return (
                <label
                  key={o.id}
                  className={cn(
                    "flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border-2 p-3",
                    checked ? "border-brand-strong bg-brand-soft" : "border-line bg-surface",
                  )}
                >
                  <input
                    type="radio"
                    name="package"
                    className="mt-1 h-5 w-5 accent-[var(--brand-strong)]"
                    checked={checked}
                    onChange={() => {
                      setTouched(true);
                      setLines({ [o.id]: 1 });
                    }}
                  />
                  <span>
                    <span className="block font-semibold">
                      {o.name} {fmtPence(o.unitPricePence, true)}
                    </span>
                    {o.includedChildren ? <span className="block text-sm text-muted">Includes {o.includedChildren} children</span> : null}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : (
        <div className="mb-4 rounded-2xl border border-line bg-surface px-4">
          {catalogue.options.map((o) => {
            const v = lines[o.id] ?? 0;
            const roomLeft = sessionCap - placesNow;
            return (
              <Stepper
                key={o.id}
                id={`opt-${o.id}`}
                label={`${o.name} ${fmtPence(o.unitPricePence, true)}`}
                hint={o.inStoreNoteShort ?? o.blurb}
                value={v}
                max={Math.min(v + Math.max(roomLeft, 0), o.maxPerBooking ?? Number.POSITIVE_INFINITY)}
                onChange={(n) => {
                  setTouched(true);
                  setLines((cur) => ({ ...cur, [o.id]: n }));
                }}
              />
            );
          })}
        </div>
      )}

      {catalogue.addOns.length ? (
        <div className="mb-4">
          <p className="mb-2 text-base font-bold">Extras</p>
          <div className="rounded-2xl border border-line bg-surface px-4">
            {catalogue.addOns.map((a) => (
              <Stepper
                key={a.id}
                id={`add-${a.id}`}
                label={`${a.name} ${fmtPence(a.pricePence, true)}${a.perChild ? " each" : ""}`}
                hint={a.kind === "time" ? `Adds ${a.extraMinutes} minutes` : a.blurb}
                value={addOns[a.id] ?? 0}
                max={a.maxQuantity}
                onChange={(n) => {
                  setTouched(true);
                  setAddOns((cur) => ({ ...cur, [a.id]: n }));
                }}
              />
            ))}
          </div>
        </div>
      ) : null}

      {catalogue.options.map((o) => (
        <input key={o.id} type="hidden" name={`line:${o.id}`} value={lines[o.id] ?? 0} />
      ))}
      {catalogue.addOns.map((a) => (
        <input key={a.id} type="hidden" name={`addon:${a.id}`} value={addOns[a.id] ?? 0} />
      ))}

      <div className="rounded-2xl border border-line bg-surface p-4">
        {result.q ? (
          <>
            <ul className="mb-2 space-y-1 text-sm">
              {[...result.q.lines, ...result.q.addOns].map((l) => (
                <li key={"optionId" in l ? l.optionId : l.addOnId} className="flex justify-between gap-2">
                  <span>
                    {l.qty} × {l.name}
                  </span>
                  <span className="tabular-nums">{fmtPence(l.totalPence)}</span>
                </li>
              ))}
            </ul>
            <p className="flex items-baseline justify-between border-t border-line pt-2" aria-live="polite">
              <span className="text-lg font-semibold">
                Total{isSlot ? ` (${result.q.places} children)` : ` (${result.q.places} ${result.q.places === 1 ? "place" : "places"})`}
              </span>
              <span className="text-2xl font-bold tabular-nums">{fmtPence(result.q.totalPence)}</span>
            </p>
            {result.q.inStoreNotes.length ? (
              <ul className="mt-2 space-y-1 text-sm text-muted">
                {result.q.inStoreNotes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : nothingChosen ? (
          touched ? null : (
            <p className="text-muted">The total shows here once you add places.</p>
          )
        ) : (
          <p role="alert" className="font-semibold text-danger">
            {result.error ?? "Check the places and extras."}
          </p>
        )}
        {/* Always in the page so screen readers announce it when it fills in. */}
        <p role="status" className="font-semibold empty:hidden">
          {touched && nothingChosen ? "Choose at least one place." : null}
        </p>
      </div>
    </div>
  );
}
