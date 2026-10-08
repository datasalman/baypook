"use client";

import { useEffect, useState, type ReactNode } from "react";
import { friendlyMessage, type BayPookClient } from "@/client/client";
import type { Availability, Service, SessionAvailability, SlotStart, Venue } from "@/client/types";
import { formatDay, formatTime } from "../_lib/dates";
import { BackButton, Button, focusRing, Loading, Notice, StepHeading } from "./ui";

/** What this customer is already holding on this day: availability counts it as taken, but it is theirs. */
export interface HeldOnDay {
  sessionId?: string;
  places: number;
  startsAt: string;
  endsAt: string;
}

/** Give the customer's own held places back to the session they are holding. */
function withHeldPlaces(s: SessionAvailability, held: HeldOnDay | null): SessionAvailability {
  if (!held || held.sessionId !== s.id || held.places <= 0) return s;
  const remaining = Math.min(s.capacity, s.remaining + held.places);
  if (s.bookable) return { ...s, remaining };
  return s.reason === "full" ? { ...s, remaining, bookable: true, reason: null } : s;
}

/** Put the customer's own held party time back in the list (same extras, so it still fits). */
function withHeldStart(starts: SlotStart[], held: HeldOnDay | null): SlotStart[] {
  if (!held || held.sessionId || starts.some((s) => s.startsAt === held.startsAt)) return starts;
  return [...starts, { startsAt: held.startsAt, endsAt: held.endsAt }].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

const REASON_LABEL: Record<NonNullable<SessionAvailability["reason"]>, string> = {
  full: "Full",
  cutoff: "Too late to book online",
  lead_time: "Too soon to book online",
  blocked: "Not available",
  room_busy: "Not available",
  cancelled: "Not running",
  past: "Finished",
};

export function TimeStep({
  client,
  venue,
  service,
  date,
  extraMinutes,
  selectedId,
  held,
  flash,
  busy,
  onSelectSession,
  onSelectSlot,
  onBack,
  backLabel,
}: {
  client: BayPookClient;
  venue: Venue;
  service: Service;
  date: string;
  extraMinutes: number;
  /** Session id or slot startsAt currently chosen. */
  selectedId: string | null;
  /** The customer's own active hold on this day, if any (with unchanged extras for parties). */
  held: HeldOnDay | null;
  /** A message to show above the times, e.g. "That time has just gone". */
  flash: string | null;
  /** True while a hold is being placed (slots). */
  busy: boolean;
  onSelectSession: (s: SessionAvailability) => void;
  onSelectSlot: (s: SlotStart) => void;
  onBack: () => void;
  backLabel: string;
}) {
  const [data, setData] = useState<Availability | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    client
      .availability(venue.slug, { service: service.id, from: date, to: date, extraMinutes: service.kind === "slot" ? extraMinutes : undefined })
      .then((av) => live && setData(av))
      .catch((err: unknown) => live && setError(friendlyMessage(err)));
    return () => {
      live = false;
    };
  }, [client, venue.slug, service.id, service.kind, date, extraMinutes, reload]);

  const tz = venue.timezone;
  const btn = `min-h-12 w-full rounded-lg border px-4 py-2 text-left text-base ${focusRing}`;

  let body: ReactNode = null;
  if (error) {
    body = (
      <Notice kind="error">
        <p>{error}</p>
        <Button variant="secondary" className="mt-3" onClick={() => setReload((n) => n + 1)}>
          Try again
        </Button>
      </Notice>
    );
  } else if (!data) {
    body = <Loading>Finding times…</Loading>;
  } else if (data.kind === "session") {
    const sessions = (data.days.find((d) => d.date === date)?.sessions ?? [])
      .filter((s) => s.reason !== "past")
      .map((s) => withHeldPlaces(s, held));
    body =
      sessions.length === 0 ? (
        <p className="text-neutral-800">There are no workshops left on this day. Please choose another day.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {sessions.map((s) => {
            const label = s.bookable ? `${s.remaining} left` : REASON_LABEL[s.reason ?? "blocked"];
            const isSelected = selectedId === s.id;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  disabled={!s.bookable || busy}
                  aria-pressed={isSelected}
                  onClick={() => onSelectSession(s)}
                  className={`${btn} ${
                    s.bookable
                      ? isSelected
                        ? "border-neutral-900 bg-neutral-900 text-white"
                        : "border-neutral-500 bg-white hover:bg-neutral-100"
                      : "cursor-not-allowed border-neutral-200 bg-neutral-100 text-neutral-600"
                  }`}
                >
                  <span className="font-semibold tabular-nums">{formatTime(s.startsAt, tz)}</span>
                  <span aria-hidden="true"> · </span>
                  <span className="sr-only">, </span>
                  <span>{label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      );
  } else {
    const starts = withHeldStart(data.days.find((d) => d.date === date)?.starts ?? [], held);
    body =
      starts.length === 0 ? (
        <p className="text-neutral-800">
          No party times fit on this day with what you have chosen. Try another day, or go back and change the extras.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {starts.map((s) => {
            const isSelected = selectedId === s.startsAt;
            return (
              <li key={s.startsAt}>
                <button
                  type="button"
                  disabled={busy}
                  aria-pressed={isSelected}
                  aria-label={`${formatTime(s.startsAt, tz)} to ${formatTime(s.endsAt, tz)}`}
                  onClick={() => onSelectSlot(s)}
                  className={`${btn} text-center ${
                    isSelected ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-500 bg-white hover:bg-neutral-100"
                  } disabled:opacity-60`}
                >
                  <span className="font-semibold tabular-nums">{formatTime(s.startsAt, tz)}</span>
                  <span className="block text-sm">until {formatTime(s.endsAt, tz)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      );
  }

  return (
    <section aria-labelledby="step-heading">
      <BackButton onClick={onBack} label={backLabel} />
      <StepHeading hint={`${service.name}, ${formatDay(date)}`}>What time?</StepHeading>
      {flash ? <Notice kind="error">{flash}</Notice> : null}
      {body}
      {busy ? <Loading>Holding your time…</Loading> : null}
    </section>
  );
}
