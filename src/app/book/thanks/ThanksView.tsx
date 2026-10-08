"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BayPookError, formatPence, friendlyMessage } from "@/client/client";
import type { BookingSummary } from "@/client/types";
import { DEFAULT_TZ } from "@/core/time";
import { Button, Card, focusRing, Loading, Notice } from "../_components/ui";
import { formatWhen } from "../_lib/dates";
import { forgetHold, storedHoldId } from "../_lib/holdSession";
import { FIXTURE_ALLOWED, FIXTURE_TOKEN_PREFIX, useBookingClient } from "../_lib/useBookingClient";

const POLL_EVERY_MS = 2000;
const POLL_FOR_MS = 60_000;

type Phase = "loading" | "confirming" | "done" | "slow" | "notfound";

function linkClass() {
  return `font-semibold underline underline-offset-4 ${focusRing}`;
}

function SummaryView({ summary, payInStore }: { summary: BookingSummary; payInStore: boolean }) {
  const owed = Math.max(0, summary.totalPence - summary.paidPence);
  const note = typeof summary.inStoreNote === "string" ? summary.inStoreNote : (summary.inStoreNote?.short ?? null);
  const v = summary.venue;
  const address = v.address.includes(v.postcode) ? v.address : `${v.address}, ${v.postcode}`;
  return (
    <>
      <h2 id="step-heading" tabIndex={-1} className="text-2xl font-bold outline-none">
        You&apos;re booked in
      </h2>
      <p className="mt-1 text-lg">
        Thanks, {summary.customer.firstName}. Your reference is <strong className="tabular-nums">{summary.reference}</strong>.
      </p>

      <Card className="mt-5">
        <dl className="space-y-3">
          <div>
            <dt className="text-sm font-semibold text-neutral-700">What</dt>
            <dd>{summary.service.name}</dd>
          </div>
          <div>
            <dt className="text-sm font-semibold text-neutral-700">When</dt>
            <dd>{formatWhen(summary.startsAt, summary.endsAt, DEFAULT_TZ)}</dd>
          </div>
          <div>
            <dt className="text-sm font-semibold text-neutral-700">Where</dt>
            <dd>
              {v.name}
              <br />
              {address}
              {v.mapsUrl ? (
                <>
                  <br />
                  <a href={v.mapsUrl} target="_blank" rel="noreferrer" className={linkClass()}>
                    Open in maps
                  </a>
                </>
              ) : null}
              {v.parkingNotes ? <span className="mt-1 block text-sm text-neutral-800">{v.parkingNotes}</span> : null}
            </dd>
          </div>
        </dl>

        <ul className="mt-4 space-y-1 border-t border-neutral-200 pt-3">
          {[...summary.lines, ...summary.addOns].map((item, i) => (
            <li key={`${item.name}-${i}`} className="flex justify-between gap-4">
              <span>
                {item.qty} × {item.name}
              </span>
              <span className="tabular-nums">{formatPence(item.totalPence)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 flex justify-between gap-4 border-t border-neutral-200 pt-3 text-lg font-bold">
          <span>Total</span>
          <span className="tabular-nums">{formatPence(summary.totalPence)}</span>
        </p>
        {payInStore || summary.paymentStatus === "owed" ? (
          <p className="mt-1 flex justify-between gap-4 font-semibold">
            <span>To pay in store</span>
            <span className="tabular-nums">{formatPence(owed)}</span>
          </p>
        ) : summary.paidPence > 0 ? (
          <p className="mt-1 flex justify-between gap-4 text-neutral-800">
            <span>Paid</span>
            <span className="tabular-nums">{formatPence(summary.paidPence)}</span>
          </p>
        ) : null}
        {note ? <p className="mt-3 text-sm text-neutral-800">{note}</p> : null}
      </Card>

      <p className="mt-5">We&apos;ve emailed you a confirmation with a calendar invite.</p>
      <p className="mt-2">Need to change it? Message or call us.</p>
    </>
  );
}

export function ThanksView() {
  const params = useSearchParams();
  const token = params.get("booking");
  const venue = params.get("venue");
  const cancelled = params.get("cancelled") === "1";
  const payInStore = params.get("paid") === "0";
  const fixture = FIXTURE_ALLOWED && (params.get("fixture") === "1" || (token?.startsWith(FIXTURE_TOKEN_PREFIX) ?? false));
  const client = useBookingClient(fixture);

  const [phase, setPhase] = useState<Phase>("loading");
  const [summary, setSummary] = useState<BookingSummary | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // The hold placed before payment: release it if the customer cancelled; otherwise the booking owns it.
  useEffect(() => {
    if (!client || (!cancelled && !token)) return;
    const holdId = storedHoldId();
    if (!holdId) return;
    forgetHold(holdId);
    if (cancelled) void client.releaseHold(holdId);
  }, [client, cancelled, token]);

  useEffect(() => {
    if (!client || !token || cancelled) return;
    let live = true;
    let timer: number | undefined;
    const started = Date.now();
    setPhase("loading");

    const poll = async () => {
      try {
        const s = await client.bookingSummary(token);
        if (!live) return;
        setSummary(s);
        setLastError(null);
        if (s.status !== "pending") {
          setPhase("done");
          return;
        }
      } catch (err) {
        if (!live) return;
        if (err instanceof BayPookError && err.code === "NOT_FOUND") {
          setPhase("notfound");
          return;
        }
        setLastError(friendlyMessage(err));
      }
      if (Date.now() - started >= POLL_FOR_MS) {
        setPhase("slow");
        return;
      }
      setPhase("confirming");
      timer = window.setTimeout(() => void poll(), POLL_EVERY_MS);
    };
    void poll();

    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [client, token, cancelled, attempt]);

  const banner = fixture ? (
    <p className="mb-4 rounded-lg border-2 border-dashed border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-950">
      <strong>Fixture mode (development only).</strong> This booking only exists in this browser tab.
    </p>
  ) : null;

  const restart = `/book${venue ? `?venue=${encodeURIComponent(venue)}` : ""}${fixture ? `${venue ? "&" : "?"}fixture=1` : ""}`;

  if (cancelled) {
    return (
      <section>
        {banner}
        <h2 className="text-2xl font-bold">Payment cancelled</h2>
        <p className="mt-2 text-lg">Your payment was cancelled and nothing was taken. Your places were released.</p>
        <a href={restart} className={`mt-6 inline-block ${linkClass()}`}>
          Start again
        </a>
      </section>
    );
  }

  if (!token) {
    return (
      <section>
        {banner}
        <h2 className="text-2xl font-bold">Nothing to show here</h2>
        <p className="mt-2">This page shows your booking after you pay.</p>
        <a href={restart} className={`mt-6 inline-block ${linkClass()}`}>
          Make a booking
        </a>
      </section>
    );
  }

  if (phase === "notfound") {
    return (
      <section>
        {banner}
        <h2 className="text-2xl font-bold">We could not find that booking</h2>
        <p className="mt-2">If you have paid, your confirmation email has the details. Otherwise, message or call us and we will check.</p>
        <a href={restart} className={`mt-6 inline-block ${linkClass()}`}>
          Start again
        </a>
      </section>
    );
  }

  if (summary && summary.status === "cancelled") {
    return (
      <section>
        {banner}
        <h2 className="text-2xl font-bold">This booking is no longer active</h2>
        <p className="mt-2">
          Booking {summary.reference} was cancelled. If money left your account, message or call us and we will sort it out.
        </p>
        <a href={restart} className={`mt-6 inline-block ${linkClass()}`}>
          Start again
        </a>
      </section>
    );
  }

  if (summary && phase === "done") {
    return (
      <section>
        {banner}
        <SummaryView summary={summary} payInStore={payInStore} />
        <a href={restart} className={`mt-8 inline-block ${linkClass()}`}>
          Book something else
        </a>
      </section>
    );
  }

  if (phase === "slow") {
    return (
      <section>
        {banner}
        <h2 className="text-2xl font-bold">We&apos;re still confirming your payment</h2>
        <p className="mt-2">
          This can take a minute or two. We will email you as soon as it is through. If nothing arrives within the hour, message or call
          us{summary ? ` and quote ${summary.reference}` : ""}.
        </p>
        {lastError ? <Notice kind="warning">{lastError}</Notice> : null}
        <Button variant="secondary" className="mt-5" onClick={() => setAttempt((n) => n + 1)}>
          Check again
        </Button>
      </section>
    );
  }

  return (
    <section>
      {banner}
      <Loading>{payInStore ? "Loading your booking…" : "Confirming your payment…"}</Loading>
      {lastError ? <Notice kind="warning">{lastError} We will keep trying.</Notice> : null}
    </section>
  );
}
