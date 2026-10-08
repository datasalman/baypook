"use client";

import { useActionState, useCallback, useEffect, useRef, useState, useTransition, type ChangeEvent } from "react";
import { useFormStatus } from "react-dom";
import type { Quote } from "@/core/pricing";
import { fmtPence } from "@/core/time";
import { Banner, Button, Checkbox, Field, Input, Textarea, useSubmitWithoutReset } from "@/components/ui";
import { QuantitiesEditor, type EditorCatalogue } from "../_components/QuantitiesEditor";
import { createManualBookingAction, searchCustomersAction, type CustomerHit, type NewBookingState } from "./actions";

export type CustomerPrefill = { firstName: string; lastName: string; email: string; phone: string };

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" block disabled={disabled || pending}>
      {pending ? "Making the booking…" : "Create booking"}
    </Button>
  );
}

function CustomerSearch({ onPick }: { onPick: (c: CustomerHit) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CustomerHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [pending, startTransition] = useTransition();
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      setSearched(false);
      return;
    }
    const n = ++seq.current;
    const t = setTimeout(() => {
      startTransition(async () => {
        const res = await searchCustomersAction(term);
        if (n === seq.current) {
          setHits(res);
          setSearched(true);
        }
      });
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="mb-4">
      <Field label="Find a parent" htmlFor="customer-search" hint="Phone, email or name. Or type their details below.">
        <Input
          id="customer-search"
          type="search"
          autoComplete="off"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-controls="customer-hits"
        />
      </Field>
      <div id="customer-hits" aria-live="polite">
        {pending ? <p className="text-sm text-muted">Searching…</p> : null}
        {hits.length ? (
          <ul className="-mt-2 mb-2 flex flex-col gap-1">
            {hits.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(h);
                    setQ("");
                    setHits([]);
                  }}
                  className="flex min-h-12 w-full flex-col items-start rounded-xl border-2 border-line bg-surface px-3 py-2 text-left hover:border-ink/40"
                >
                  <span className="font-semibold">
                    {h.firstName} {h.lastName}
                  </span>
                  <span className="text-sm text-muted [overflow-wrap:anywhere]">{[h.phone, h.email].filter(Boolean).join(" · ") || "No contact details"}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : searched && !pending ? (
          <p className="-mt-2 mb-2 text-sm text-muted">No match. Type their details below.</p>
        ) : null}
      </div>
    </div>
  );
}

export function NewBookingForm({
  venueId,
  serviceId,
  sessionId,
  startsAtIso,
  catalogue,
  placesLeft,
  initialAddOns,
  prefill,
}: {
  venueId: string;
  serviceId: string;
  sessionId: string | null;
  startsAtIso: string | null;
  catalogue: EditorCatalogue;
  placesLeft: number | null;
  initialAddOns: Record<string, number>;
  prefill: CustomerPrefill | null;
}) {
  const [state, action] = useActionState<NewBookingState, FormData>(createManualBookingAction, { error: null });
  const [q, setQ] = useState<Quote | null>(null);
  const onQuote = useCallback((next: Quote | null) => setQ(next), []);
  const [customer, setCustomer] = useState<CustomerPrefill>(prefill ?? { firstName: "", lastName: "", email: "", phone: "" });
  const [noEmail, setNoEmail] = useState(Boolean(prefill && !prefill.email));
  const [payment, setPayment] = useState<"cash" | "card_machine" | "pay_in_store">("card_machine");
  const isSlot = catalogue.kind === "slot";
  const errorRef = useRef<HTMLDivElement>(null);
  // Submitting from onSubmit skips React's form reset, so the payment radios and the
  // "No email" box keep their state. The typed free-text values also come back with an
  // error, for the no-JavaScript post.
  const onSubmit = useSubmitWithoutReset(action);
  const typed = state.values;

  useEffect(() => {
    if (state.error) errorRef.current?.focus();
  }, [state]);

  const set = (k: keyof CustomerPrefill) => (e: ChangeEvent<HTMLInputElement>) => setCustomer((c) => ({ ...c, [k]: e.target.value }));

  return (
    <form action={action} onSubmit={onSubmit}>
      <input type="hidden" name="venueId" value={venueId} />
      <input type="hidden" name="serviceId" value={serviceId} />
      {sessionId ? <input type="hidden" name="sessionId" value={sessionId} /> : null}
      {startsAtIso ? <input type="hidden" name="startsAt" value={startsAtIso} /> : null}

      <h2 className="mb-2 mt-2 text-lg font-bold">{isSlot ? "Package and extras" : "Places"}</h2>
      <QuantitiesEditor catalogue={catalogue} placesLeft={placesLeft} initialAddOns={initialAddOns} onQuote={onQuote} />

      <h2 className="mb-2 mt-6 text-lg font-bold">Parent</h2>
      <CustomerSearch
        onPick={(h) => {
          setCustomer({ firstName: h.firstName, lastName: h.lastName, email: h.email, phone: h.phone ?? "" });
          setNoEmail(!h.email);
        }}
      />
      <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
        <Field label="First name" htmlFor="firstName">
          <Input id="firstName" name="firstName" autoComplete="off" required value={customer.firstName} onChange={set("firstName")} />
        </Field>
        <Field label="Last name" htmlFor="lastName" optional>
          <Input id="lastName" name="lastName" autoComplete="off" value={customer.lastName} onChange={set("lastName")} />
        </Field>
      </div>
      <Field label="Phone" htmlFor="phone" optional>
        <Input id="phone" name="phone" type="tel" autoComplete="off" value={customer.phone} onChange={set("phone")} />
      </Field>
      <Field label="Email" htmlFor="email" hint={noEmail ? "No confirmation email will be sent." : "The confirmation goes here."}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="off"
          value={noEmail ? "" : customer.email}
          onChange={set("email")}
          disabled={noEmail}
          required={!noEmail}
        />
      </Field>
      <Checkbox name="noEmail" label="No email (walk-in)" checked={noEmail} onChange={(e) => setNoEmail(e.target.checked)} />

      {isSlot ? (
        <>
          <h2 className="mb-2 mt-6 text-lg font-bold">Birthday child</h2>
          <div className="grid grid-cols-2 gap-x-3">
            <Field label="First name" htmlFor="birthdayName" optional>
              <Input id="birthdayName" name="birthdayName" autoComplete="off" maxLength={60} defaultValue={typed?.birthdayName} />
            </Field>
            <Field label="Age they are turning" htmlFor="birthdayAge" optional>
              <Input id="birthdayAge" name="birthdayAge" type="number" inputMode="numeric" min={1} max={18} defaultValue={typed?.birthdayAge} />
            </Field>
          </div>
        </>
      ) : null}

      <fieldset className="mt-6">
        <legend className="mb-2 text-lg font-bold">Payment</legend>
        {(
          [
            ["card_machine", "Paid by card machine"],
            ["cash", "Paid in cash"],
            ["pay_in_store", "To pay in store (owed)"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex min-h-12 cursor-pointer items-center gap-3">
            <input
              type="radio"
              name="payment"
              value={value}
              checked={payment === value}
              onChange={() => setPayment(value)}
              className="h-5 w-5 accent-[var(--brand-strong)]"
            />
            {label}
          </label>
        ))}
      </fieldset>
      {payment !== "pay_in_store" ? (
        <Field
          label="Amount taken (£)"
          htmlFor="amount"
          optional
          className="mt-2"
          hint={q ? `Leave empty for the full total, ${fmtPence(q.totalPence)}.` : "Leave empty for the full total."}
        >
          <Input id="amount" name="amount" inputMode="decimal" autoComplete="off" defaultValue={typed?.amount} />
        </Field>
      ) : (
        <p className="mb-4 mt-2 text-sm text-muted">{q ? `${fmtPence(q.totalPence)} will show as owed until it is paid in store.` : null}</p>
      )}

      <Field label="Notes" htmlFor="notes" optional hint="Allergies, anything the parent said. Staff only.">
        <Textarea id="notes" name="notes" maxLength={5000} rows={3} defaultValue={typed?.notes} />
      </Field>

      {state.error ? (
        <div ref={errorRef} tabIndex={-1} className="mb-3 outline-none">
          <Banner tone="danger">{state.error}</Banner>
        </div>
      ) : null}
      <SubmitButton disabled={!q} />
    </form>
  );
}
