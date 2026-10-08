"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { fmtPence } from "@/core/time";
import { Banner, Button } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import type { EditorCatalogue } from "../../_components/QuantitiesEditor";
import { changeCountsAction, type ChangeCountsState } from "../actions";
import { previewCountsAction, type CountsPreviewState } from "./actions";

/** What the booking already has of one option or extra, at the prices it was sold at. */
export type SoldItem = { qty: number; unitPence: number; includedChildren?: number | null };

function SaveButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" block disabled={disabled || pending}>
      {pending ? "Saving…" : "Save changes"}
    </Button>
  );
}

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

/** "2 paid at £17.00, more at £18.00" for an item already on the booking. */
function soldHint(sold: SoldItem[] | undefined, todayPence: number, archived: boolean): string | null {
  if (!sold?.length) return null;
  const paid = sold.map((t) => `${t.qty} at ${fmtPence(t.unitPence)}`).join(", ");
  if (archived) return `No longer sold. Already booked: ${paid}.`;
  const sameAsToday = sold.every((t) => t.unitPence === todayPence);
  return sameAsToday ? `Already booked: ${paid}.` : `Already booked: ${paid}. More at ${fmtPence(todayPence)}.`;
}

/**
 * Change the places, package or extras of a booking. The price shown is worked
 * out on the server with the same rules as saving: places already paid for keep
 * their price, added places and new extras are at today's price.
 */
export function ChangeCountsForm({
  bookingId,
  catalogue,
  sold,
  archivedIds,
  initialLines,
  initialAddOns,
  placesLeft,
  paidPence,
  refundedPence,
}: {
  bookingId: string;
  catalogue: EditorCatalogue;
  /** Per option id / add-on id: the price tranches already on the booking. */
  sold: { options: Record<string, SoldItem[]>; addOns: Record<string, SoldItem[]> };
  /** Items no longer on sale that are on this booking. */
  archivedIds: string[];
  initialLines: Record<string, number>;
  initialAddOns: Record<string, number>;
  placesLeft: number | null;
  paidPence: number;
  refundedPence: number;
}) {
  const [state, action] = useActionState<ChangeCountsState, FormData>(changeCountsAction, { error: null });
  const isSlot = catalogue.kind === "slot";
  const archived = new Set(archivedIds);

  const [lines, setLines] = useState<Record<string, number>>(() => {
    if (isSlot) {
      const chosen = catalogue.options.find((o) => (initialLines[o.id] ?? 0) > 0) ?? catalogue.options[0];
      return chosen ? { [chosen.id]: 1 } : {};
    }
    return { ...initialLines };
  });
  const [addOns, setAddOns] = useState<Record<string, number>>({ ...initialAddOns });
  const [preview, setPreview] = useState<CountsPreviewState | null>(null);
  const [previewFor, setPreviewFor] = useState<string>("");

  const placesNow = Object.values(lines).reduce((n, v) => n + v, 0);
  const sessionCap = Math.min(catalogue.maxPlacesPerBooking, placesLeft ?? Number.POSITIVE_INFINITY);
  const overCap = !isSlot && placesLeft !== null && placesNow > placesLeft;
  const selection = JSON.stringify({
    lines: Object.entries(lines)
      .filter(([, q]) => q > 0)
      .map(([optionId, qty]) => ({ optionId, qty })),
    addOns: Object.entries(addOns)
      .filter(([, q]) => q > 0)
      .map(([addOnId, qty]) => ({ addOnId, qty })),
  });

  // Ask the server for the price of each new selection (latest request wins).
  const seq = useRef(0);
  useEffect(() => {
    if (placesNow === 0 || overCap) return;
    const mine = ++seq.current;
    const timer = window.setTimeout(() => {
      const sel = JSON.parse(selection) as Pick<Parameters<typeof previewCountsAction>[0], "lines" | "addOns">;
      previewCountsAction({ bookingId, ...sel })
        .then((p) => {
          if (mine !== seq.current) return;
          setPreview(p);
          setPreviewFor(selection);
        })
        .catch(() => {
          if (mine !== seq.current) return;
          setPreview({ ok: false, error: "We could not work out the price. Please try again." });
          setPreviewFor(selection);
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [bookingId, selection, placesNow, overCap]);

  const current = previewFor === selection ? preview : null;
  const ready = Boolean(current?.ok) && placesNow > 0 && !overCap;
  const delta = current?.ok ? current.delta : 0;

  return (
    <form action={action}>
      <input type="hidden" name="bookingId" value={bookingId} />

      {isSlot ? (
        <fieldset className="mb-4">
          <legend className="mb-2 text-base font-bold">Package</legend>
          <div className="flex flex-col gap-2">
            {catalogue.options.map((o) => {
              const checked = (lines[o.id] ?? 0) > 0;
              const soldAt = sold.options[o.id]?.[0];
              const price = soldAt ? soldAt.unitPence : o.unitPricePence;
              const children = soldAt ? (soldAt.includedChildren ?? o.includedChildren) : o.includedChildren;
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
                    onChange={() => setLines({ [o.id]: 1 })}
                  />
                  <span>
                    <span className="block font-semibold">
                      {o.name} {fmtPence(price, true)}
                    </span>
                    {children ? <span className="block text-sm text-muted">Includes {children} children</span> : null}
                    {soldAt ? (
                      <span className="block text-sm text-muted">
                        {archived.has(o.id) ? "No longer sold. " : ""}Already booked at this price.
                      </span>
                    ) : null}
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
                label={sold.options[o.id] ? o.name : `${o.name} ${fmtPence(o.unitPricePence, true)}`}
                hint={soldHint(sold.options[o.id], o.unitPricePence, archived.has(o.id)) ?? o.inStoreNoteShort ?? o.blurb}
                value={v}
                max={Math.min(v + Math.max(roomLeft, 0), o.maxPerBooking ?? Number.POSITIVE_INFINITY)}
                onChange={(n) => setLines((cur) => ({ ...cur, [o.id]: n }))}
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
                label={sold.addOns[a.id] ? a.name : `${a.name} ${fmtPence(a.pricePence, true)}${a.perChild ? " each" : ""}`}
                hint={soldHint(sold.addOns[a.id], a.pricePence, archived.has(a.id)) ?? (a.kind === "time" ? `Adds ${a.extraMinutes} minutes` : a.blurb)}
                value={addOns[a.id] ?? 0}
                max={a.maxQuantity}
                onChange={(n) => setAddOns((cur) => ({ ...cur, [a.id]: n }))}
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

      <div className="rounded-2xl border border-line bg-surface p-4" aria-live="polite">
        {placesNow === 0 ? (
          <p role="alert" className="font-semibold text-danger">
            Choose at least one place.
          </p>
        ) : overCap ? (
          <p role="alert" className="font-semibold text-danger">
            Only {placesLeft} {placesLeft === 1 ? "place" : "places"} left at this time.
          </p>
        ) : !current ? (
          <p className="text-muted">Working out the price…</p>
        ) : !current.ok ? (
          <p role="alert" className="font-semibold text-danger">
            {current.error}
          </p>
        ) : (
          <>
            <ul className="mb-2 space-y-1 text-sm">
              {current.items.map((l) => (
                <li key={l.key} className="flex justify-between gap-2">
                  <span>
                    {l.qty} × {l.name} at {fmtPence(l.unitPence)}
                  </span>
                  <span className="tabular-nums">{fmtPence(l.totalPence)}</span>
                </li>
              ))}
            </ul>
            <p className="flex items-baseline justify-between border-t border-line pt-2">
              <span className="text-lg font-semibold">
                New total{isSlot ? ` (${current.places} children)` : ` (${current.places} ${current.places === 1 ? "place" : "places"})`}
              </span>
              <span className="text-2xl font-bold tabular-nums">{fmtPence(current.totalPence)}</span>
            </p>
          </>
        )}
      </div>

      <p className="mt-3 text-base" aria-live="polite">
        Paid so far: <strong className="tabular-nums">{fmtPence(paidPence)}</strong>
        {refundedPence > 0 ? <> ({fmtPence(refundedPence)} given back)</> : null}
        {ready ? (
          delta > 0 ? (
            <>
              {" "}
              · To collect in store: <strong className="tabular-nums">{fmtPence(delta)}</strong>
            </>
          ) : delta < 0 ? (
            <>
              {" "}
              · Give a refund of <strong className="tabular-nums">{fmtPence(-delta)}</strong> after saving
            </>
          ) : (
            " · Nothing more to pay"
          )
        ) : null}
      </p>
      {state.error ? (
        <Banner tone="danger" className="mt-3">
          {state.error}
        </Banner>
      ) : null}
      <div className="mt-4">
        <SaveButton disabled={!ready} />
      </div>
    </form>
  );
}
