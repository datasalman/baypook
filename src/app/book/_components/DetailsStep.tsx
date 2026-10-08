"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { BayPookError, formatPence, friendlyMessage, isPayInStoreCheckout, type BayPookClient } from "@/client/client";
import type { CheckoutRequest, HoldResponse, Service, Venue } from "@/client/types";
import { formatWhen } from "../_lib/dates";
import { DETAIL_FIELDS, validateDetails, type DetailsErrors, type DetailsInput } from "../_lib/validate";
import { HoldTimer } from "./HoldTimer";
import { BackButton, Button, Card, focusRing, Notice, StepHeading } from "./ui";

// The website owns these links; this reference page points at Slimedom's live terms page.
const TERMS_URL = "https://slimedom.com/terms";

const EMPTY: DetailsInput = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  childName: "",
  childAge: "",
  message: "",
  terms: false,
  waiver: false,
};

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="block font-semibold">
        {label}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-neutral-700">
          {hint}
        </p>
      ) : null}
      <div className="mt-1">{children}</div>
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-sm font-medium text-red-800">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const inputClass = `block min-h-12 w-full rounded-lg border border-neutral-500 bg-white px-3 py-2 text-base text-neutral-950 aria-[invalid=true]:border-red-700 ${focusRing}`;

function describedBy(id: string, error?: string, hint?: boolean): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

export function BookingSummaryPanel({ hold, service, venue }: { hold: HoldResponse; service: Service; venue: Venue }) {
  const q = hold.quote;
  return (
    <Card>
      <h3 className="text-lg font-semibold">Your booking</h3>
      <dl className="mt-2 space-y-1 text-neutral-900">
        <div>
          <dt className="sr-only">What</dt>
          <dd className="font-medium">{service.name}</dd>
        </div>
        <div>
          <dt className="sr-only">When</dt>
          <dd>{formatWhen(hold.hold.startsAt, hold.hold.endsAt, venue.timezone)}</dd>
        </div>
        <div>
          <dt className="sr-only">Where</dt>
          <dd>{venue.name}</dd>
        </div>
      </dl>
      <ul className="mt-3 space-y-1 border-t border-neutral-200 pt-3">
        {q.lines.map((l) => (
          <li key={l.optionId} className="flex justify-between gap-4">
            <span>
              {l.qty} × {l.name}
              {l.includedChildren ? ` (${l.includedChildren} children)` : ""}
            </span>
            <span className="tabular-nums">{formatPence(l.totalPence)}</span>
          </li>
        ))}
        {q.addOns.map((a) => (
          <li key={a.addOnId} className="flex justify-between gap-4">
            <span>
              {a.kind === "time" ? `${a.name} (+${a.extraMinutes * a.qty} min)` : `${a.qty} × ${a.name}`}
            </span>
            <span className="tabular-nums">{formatPence(a.totalPence)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 flex justify-between gap-4 border-t border-neutral-200 pt-3 text-lg font-bold">
        <span>Total</span>
        <span className="tabular-nums">{formatPence(q.totalPence)}</span>
      </p>
      {q.inStoreNotes.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm text-neutral-800">
          {q.inStoreNotes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

export function DetailsStep({
  client,
  venue,
  service,
  hold,
  expired,
  onExpire,
  onChooseAgain,
  onCheckoutRedirect,
  onBack,
}: {
  client: BayPookClient;
  venue: Venue;
  service: Service;
  hold: HoldResponse;
  expired: boolean;
  onExpire: () => void;
  onChooseAgain: () => void;
  /** Called just before leaving for payment (or the thank-you page): the hold now belongs to the booking. */
  onCheckoutRedirect: () => void;
  onBack: () => void;
}) {
  const isParty = service.kind === "slot";
  const [input, setInput] = useState<DetailsInput>(EMPTY);
  const [errors, setErrors] = useState<DetailsErrors>({});
  const [submitted, setSubmitted] = useState(false);
  const [payInStore, setPayInStore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const set = <K extends keyof DetailsInput>(key: K, value: DetailsInput[K]) => {
    const next = { ...input, [key]: value };
    setInput(next);
    if (submitted) setErrors(validateDetails(next, isParty));
  };

  const total = hold.quote.totalPence;
  const payLabel = payInStore && service.payInStoreEnabled ? "Book, pay in store" : `Pay ${formatPence(total)}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    const found = validateDetails(input, isParty);
    setErrors(found);
    const first = DETAIL_FIELDS.find((f) => found[f]);
    if (first) {
      document.getElementById(`f-${first}`)?.focus();
      return;
    }
    setBusy(true);
    setServerError(null);
    const body: CheckoutRequest = {
      holdId: hold.hold.id,
      customer: {
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        email: input.email.trim(),
        phone: input.phone.trim(),
      },
      accept: { terms: input.terms, waiver: input.waiver },
      returnUrl: `${window.location.origin}/book/thanks`,
      payInStore: service.payInStoreEnabled && payInStore,
    };
    if (isParty) body.birthdayChild = { firstName: input.childName.trim(), age: Number(input.childAge) };
    if (input.message.trim()) body.message = input.message.trim();
    try {
      const res = await client.checkout(body);
      onCheckoutRedirect();
      // Leave the page: to Stripe Checkout (or the demo checkout), or straight to the thank-you page.
      window.location.assign(isPayInStoreCheckout(res) ? res.thanksUrl : res.checkoutUrl);
    } catch (err) {
      setBusy(false);
      if (err instanceof BayPookError && err.code === "HOLD_EXPIRED") {
        onExpire();
        return;
      }
      setServerError(friendlyMessage(err));
    }
  }

  if (expired) {
    return (
      <section aria-labelledby="step-heading">
        <StepHeading>Your time ran out</StepHeading>
        <Notice kind="warning">{friendlyMessage(new BayPookError("HOLD_EXPIRED", "", 410))}</Notice>
        <Button className="w-full" onClick={onChooseAgain}>
          Choose a time again
        </Button>
      </section>
    );
  }

  const err = (k: keyof DetailsInput) => errors[k];

  return (
    <section aria-labelledby="step-heading">
      <BackButton onClick={onBack} label="Change your booking" />
      <StepHeading>Your details</StepHeading>
      <HoldTimer expiresAt={hold.hold.expiresAt} what={isParty ? "party time" : "places"} onExpire={onExpire} />

      <BookingSummaryPanel hold={hold} service={service} venue={venue} />

      <form noValidate onSubmit={submit} className="mt-6 space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="f-firstName" label="First name" error={err("firstName")}>
            <input
              id="f-firstName"
              className={inputClass}
              autoComplete="given-name"
              value={input.firstName}
              onChange={(e) => set("firstName", e.target.value)}
              aria-invalid={!!err("firstName")}
              aria-describedby={describedBy("f-firstName", err("firstName"))}
              required
            />
          </Field>
          <Field id="f-lastName" label="Last name" error={err("lastName")}>
            <input
              id="f-lastName"
              className={inputClass}
              autoComplete="family-name"
              value={input.lastName}
              onChange={(e) => set("lastName", e.target.value)}
              aria-invalid={!!err("lastName")}
              aria-describedby={describedBy("f-lastName", err("lastName"))}
              required
            />
          </Field>
        </div>
        <Field id="f-email" label="Email" hint="We send your confirmation here." error={err("email")}>
          <input
            id="f-email"
            type="email"
            inputMode="email"
            className={inputClass}
            autoComplete="email"
            value={input.email}
            onChange={(e) => set("email", e.target.value)}
            aria-invalid={!!err("email")}
            aria-describedby={describedBy("f-email", err("email"), true)}
            required
          />
        </Field>
        <Field id="f-phone" label="Phone" hint="In case we need to reach you on the day." error={err("phone")}>
          <input
            id="f-phone"
            type="tel"
            inputMode="tel"
            className={inputClass}
            autoComplete="tel"
            value={input.phone}
            onChange={(e) => set("phone", e.target.value)}
            aria-invalid={!!err("phone")}
            aria-describedby={describedBy("f-phone", err("phone"), true)}
            required
          />
        </Field>

        {isParty ? (
          <fieldset className="space-y-5 rounded-xl border border-neutral-300 p-4">
            <legend className="px-1 font-semibold">The birthday child</legend>
            <Field id="f-childName" label="First name" error={err("childName")}>
              <input
                id="f-childName"
                className={inputClass}
                autoComplete="off"
                value={input.childName}
                onChange={(e) => set("childName", e.target.value)}
                aria-invalid={!!err("childName")}
                aria-describedby={describedBy("f-childName", err("childName"))}
                required
              />
            </Field>
            <Field id="f-childAge" label="Age they will be" error={err("childAge")}>
              <input
                id="f-childAge"
                type="number"
                inputMode="numeric"
                min={1}
                max={16}
                className={`${inputClass} max-w-32`}
                value={input.childAge}
                onChange={(e) => set("childAge", e.target.value)}
                aria-invalid={!!err("childAge")}
                aria-describedby={describedBy("f-childAge", err("childAge"))}
                required
              />
            </Field>
          </fieldset>
        ) : null}

        <Field id="f-message" label="Allergies or anything we should know (optional)" error={err("message")}>
          <textarea
            id="f-message"
            rows={3}
            className={inputClass}
            value={input.message}
            onChange={(e) => set("message", e.target.value)}
            aria-invalid={!!err("message")}
            aria-describedby={describedBy("f-message", err("message"))}
          />
        </Field>

        {service.payInStoreEnabled ? (
          <fieldset>
            <legend className="mb-2 font-semibold">How would you like to pay?</legend>
            <div className="space-y-2">
              {[
                { value: false, label: "Pay now by card" },
                { value: true, label: "Pay in store" },
              ].map((o) => (
                <label key={o.label} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border border-neutral-400 bg-white px-3">
                  <input
                    type="radio"
                    name="payment"
                    checked={payInStore === o.value}
                    onChange={() => setPayInStore(o.value)}
                    className="h-5 w-5 accent-neutral-900"
                  />
                  {o.label}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        <div className="space-y-3">
          {(
            [
              {
                key: "terms",
                label: (
                  <>
                    I agree to the{" "}
                    <a href={TERMS_URL} target="_blank" rel="noreferrer" className={`underline ${focusRing}`}>
                      terms and conditions and privacy policy
                    </a>
                  </>
                ),
              },
              { key: "waiver", label: <>I have read and agree to the liability waiver</> },
            ] as const
          ).map(({ key, label }) => (
            <div key={key}>
              <div className="flex items-start gap-3">
                <input
                  id={`f-${key}`}
                  type="checkbox"
                  checked={input[key]}
                  onChange={(e) => set(key, e.target.checked)}
                  className="mt-0.5 h-6 w-6 shrink-0 accent-neutral-900"
                  aria-invalid={!!err(key)}
                  aria-describedby={describedBy(`f-${key}`, err(key))}
                  required
                />
                <label htmlFor={`f-${key}`} className="cursor-pointer">
                  {label}
                </label>
              </div>
              {err(key) ? (
                <p id={`f-${key}-error`} className="ml-9 mt-1 text-sm font-medium text-red-800">
                  {err(key)}
                </p>
              ) : null}
            </div>
          ))}
        </div>

        {serverError ? <Notice kind="error">{serverError}</Notice> : null}
        {submitted && Object.keys(errors).length > 0 ? (
          <p role="alert" className="font-medium text-red-800">
            Please check the details marked above.
          </p>
        ) : null}

        <Button type="submit" className="w-full text-lg" disabled={busy}>
          {busy ? (payInStore ? "Booking…" : "Taking you to payment…") : payLabel}
        </Button>
        {!(payInStore && service.payInStoreEnabled) ? (
          <p className="text-center text-sm text-neutral-700">You pay on a secure payment page. We never see your card details.</p>
        ) : null}
      </form>
    </section>
  );
}
