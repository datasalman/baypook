"use client";

import { formatPence } from "@/client/client";
import type { AddOn, Service, SessionAvailability } from "@/client/types";
import type { QuoteState } from "../_lib/useQuote";
import { formatDay, formatTime } from "../_lib/dates";
import { BackButton, Button, Card, focusRing, Notice, StepHeading, Stepper } from "./ui";

function QuoteTotal({ state, emptyText }: { state: QuoteState; emptyText: string }) {
  const { quote, error, pending } = state;
  return (
    <Card className="mt-6">
      <div className="flex items-baseline justify-between gap-4" aria-live="polite" aria-busy={pending}>
        <span className="text-lg font-semibold">Total</span>
        <span className={`text-2xl font-bold tabular-nums ${pending ? "text-neutral-500" : ""}`}>
          {quote && !error ? formatPence(quote.totalPence) : "–"}
        </span>
      </div>
      {!quote && !error && !pending ? <p className="mt-1 text-sm text-neutral-700">{emptyText}</p> : null}
      {pending ? <p className="mt-1 text-sm text-neutral-700">Updating the total…</p> : null}
      {error ? (
        <p role="alert" className="mt-2 font-medium text-red-800">
          {error}
        </p>
      ) : null}
      {quote && !error && quote.inStoreNotes.length > 0 ? (
        <ul className="mt-3 space-y-1 border-t border-neutral-200 pt-3 text-sm text-neutral-800">
          {quote.inStoreNotes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

export function SessionOptionsStep({
  service,
  session,
  date,
  tz,
  qty,
  onQty,
  quote,
  busy,
  error,
  onContinue,
  onBack,
}: {
  service: Service;
  session: SessionAvailability;
  date: string;
  tz: string;
  qty: Record<string, number>;
  onQty: (optionId: string, value: number) => void;
  quote: QuoteState;
  busy: boolean;
  error: string | null;
  onContinue: () => void;
  onBack: () => void;
}) {
  const places = service.options.reduce((sum, o) => sum + (qty[o.id] ?? 0), 0);
  const roomLeft = session.remaining - places;
  const canContinue = places > 0 && !quote.pending && !quote.error && quote.quote !== null && !busy;
  return (
    <section aria-labelledby="step-heading">
      <BackButton onClick={onBack} label="Change time" />
      <StepHeading hint={`${service.name}, ${formatDay(date)} at ${formatTime(session.startsAt, tz)}`}>How many places?</StepHeading>
      <p className="mb-2 text-neutral-800">
        {session.remaining === 1 ? "Only 1 place left at this time." : `${session.remaining} places left at this time.`}
      </p>
      <Card className="py-0">
        {service.options.map((o) => (
          <Stepper
            key={o.id}
            id={`opt-${o.id}`}
            label={`${o.name} ${formatPence(o.unitPricePence)}`}
            value={qty[o.id] ?? 0}
            max={Math.min((qty[o.id] ?? 0) + roomLeft, o.maxPerBooking ?? Number.POSITIVE_INFINITY)}
            onChange={(v) => onQty(o.id, v)}
          >
            {o.blurb ? <p>{o.blurb}</p> : null}
            {o.inStoreNote ? (
              <p className="mt-1 font-medium text-neutral-900">
                {o.inStoreNote.line}
                {o.inStoreNote.menuUrl ? (
                  <>
                    {" "}
                    <a href={o.inStoreNote.menuUrl} target="_blank" rel="noreferrer" className={`underline ${focusRing}`}>
                      See the pieces
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
          </Stepper>
        ))}
      </Card>
      {roomLeft <= 0 && places > 0 ? <p className="mt-2 text-sm text-neutral-800">That is every place left at this time.</p> : null}
      {places > 0 ? <QuoteTotal state={quote} emptyText="" /> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Button className="mt-6 w-full" disabled={!canContinue} onClick={onContinue}>
        {busy ? "Holding your places…" : places === 0 ? "Choose at least one place" : "Continue"}
      </Button>
    </section>
  );
}

export function SlotOptionsStep({
  service,
  date,
  packageId,
  onPackage,
  addOnQty,
  onAddOn,
  quote,
  onContinue,
  onBack,
}: {
  service: Service;
  date: string;
  packageId: string;
  onPackage: (optionId: string) => void;
  addOnQty: Record<string, number>;
  onAddOn: (addOnId: string, value: number) => void;
  quote: QuoteState;
  onContinue: () => void;
  onBack: () => void;
}) {
  const pkg = service.options.find((o) => o.id === packageId) ?? service.options[0];
  const included = pkg?.includedChildren ?? 0;
  const canContinue = !!pkg && !quote.pending && !quote.error && quote.quote !== null;

  const describe = (a: AddOn) => {
    if (a.perChild) {
      const max = a.maxQuantity ?? 0;
      return `${formatPence(a.pricePence)} each, up to ${included + max} children in total`;
    }
    return `${formatPence(a.pricePence)} each`;
  };

  return (
    <section aria-labelledby="step-heading">
      <BackButton onClick={onBack} label="Change day" />
      <StepHeading hint={`${service.name}, ${formatDay(date)}`}>How many children, and any extras?</StepHeading>

      {service.options.length > 1 ? (
        <fieldset className="mb-4">
          <legend className="mb-2 font-semibold">Choose a package</legend>
          <div className="space-y-2">
            {service.options.map((o) => (
              <label key={o.id} className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border border-neutral-400 bg-white p-3">
                <input
                  type="radio"
                  name="package"
                  value={o.id}
                  checked={pkg?.id === o.id}
                  onChange={() => onPackage(o.id)}
                  className="mt-1 h-5 w-5 accent-neutral-900"
                />
                <span>
                  <span className="font-semibold">
                    {o.name} {formatPence(o.unitPricePence)}
                  </span>
                  {o.blurb ? <span className="block text-sm text-neutral-700">{o.blurb}</span> : null}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : pkg ? (
        <Card className="mb-4">
          <p className="font-semibold">
            {pkg.name} {formatPence(pkg.unitPricePence)}
          </p>
          <p className="text-neutral-700">{pkg.includedChildren ? `For up to ${pkg.includedChildren} children, including the birthday child.` : pkg.blurb}</p>
          {pkg.inStoreNote ? <p className="mt-1 text-sm font-medium">{pkg.inStoreNote.line}</p> : null}
        </Card>
      ) : null}

      {service.addOns.length > 0 ? (
        <Card className="py-0">
          {service.addOns.map((a) =>
            a.kind === "time" ? (
              <label key={a.id} className="flex cursor-pointer items-start gap-3 border-b border-neutral-200 py-4 last:border-b-0">
                <input
                  type="checkbox"
                  checked={(addOnQty[a.id] ?? 0) > 0}
                  onChange={(e) => onAddOn(a.id, e.target.checked ? 1 : 0)}
                  className="mt-1 h-5 w-5 shrink-0 accent-neutral-900"
                />
                <span>
                  <span className="font-semibold">
                    {a.name} (+{a.extraMinutes} min) {formatPence(a.pricePence)}
                  </span>
                  {a.blurb ? <span className="block text-sm text-neutral-700">{a.blurb}</span> : null}
                </span>
              </label>
            ) : (
              <Stepper
                key={a.id}
                id={`addon-${a.id}`}
                label={a.perChild ? "Extra children" : a.name}
                value={addOnQty[a.id] ?? 0}
                max={a.maxQuantity ?? 20}
                onChange={(v) => onAddOn(a.id, v)}
              >
                <p>{describe(a)}</p>
                {a.blurb ? <p>{a.blurb}</p> : null}
              </Stepper>
            ),
          )}
        </Card>
      ) : null}

      {quote.quote && !quote.error ? (
        <p className="mt-4 text-neutral-800">
          {quote.quote.places} {quote.quote.places === 1 ? "child" : "children"} in total
          {quote.quote.extraMinutes > 0 ? `, with ${quote.quote.extraMinutes} extra minutes` : ""}.
        </p>
      ) : null}
      <QuoteTotal state={quote} emptyText="" />
      <Button className="mt-6 w-full" disabled={!canContinue} onClick={onContinue}>
        Continue to times
      </Button>
    </section>
  );
}
