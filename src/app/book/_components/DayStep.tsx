"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { friendlyMessage, type BayPookClient } from "@/client/client";
import type { Service, Venue } from "@/client/types";
import {
  addMonths,
  firstOfMonth,
  formatDay,
  formatMonth,
  lastOfMonth,
  localDateOf,
  monthOf,
  todayIn,
  weekdayMon0,
} from "../_lib/dates";
import { BackButton, Button, focusRing, Loading, Notice, StepHeading } from "./ui";

type MonthState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ok"; month: string; bookable: string[] };

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_MONTHS_AHEAD = 12;
const MAX_AUTO_ADVANCE = 6;

export function DayStep({
  client,
  venue,
  service,
  initialDate,
  onContinue,
  onBack,
}: {
  client: BayPookClient;
  venue: Venue;
  service: Service;
  initialDate: string | null;
  onContinue: (date: string) => void;
  onBack: () => void;
}) {
  const today = useMemo(() => todayIn(venue.timezone), [venue.timezone]);
  const opensOn = venue.status === "opening" && venue.opensAt ? localDateOf(venue.opensAt, venue.timezone) : null;
  const minMonth = monthOf(today);
  const maxMonth = addMonths(minMonth, MAX_MONTHS_AHEAD);

  const [month, setMonth] = useState(() => {
    if (initialDate && initialDate >= today) return monthOf(initialDate);
    return monthOf(opensOn && opensOn > today ? opensOn : today);
  });
  const [state, setState] = useState<MonthState>({ kind: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const cache = useRef(new Map<string, string[]>());
  const initialHandled = useRef(false);
  const userNavigated = useRef(false);
  const autoAdvanced = useRef(0);

  useEffect(() => {
    let live = true;
    const cached = cache.current.get(month);
    if (cached) {
      setState({ kind: "ok", month, bookable: cached });
      return;
    }
    setState({ kind: "loading" });
    const from = firstOfMonth(month) < today ? today : firstOfMonth(month);
    client
      .availability(venue.slug, { service: service.id, from, to: lastOfMonth(month) })
      .then((av) => {
        const bookable =
          av.kind === "session"
            ? av.days.filter((d) => d.sessions.some((s) => s.bookable)).map((d) => d.date)
            : av.days.filter((d) => d.starts.length > 0).map((d) => d.date);
        bookable.sort();
        cache.current.set(month, bookable);
        if (live) setState({ kind: "ok", month, bookable });
      })
      .catch((err: unknown) => {
        if (live) setState({ kind: "error", message: friendlyMessage(err) });
      });
    return () => {
      live = false;
    };
  }, [client, venue.slug, service.id, month, today, reload]);

  // Default to the deep-linked day, else the first bookable day (looking ahead a few months if needed).
  useEffect(() => {
    if (state.kind !== "ok" || selected) return;
    const { bookable } = state;
    if (initialDate && !initialHandled.current && monthOf(initialDate) === state.month) {
      initialHandled.current = true;
      if (bookable.includes(initialDate)) {
        setSelected(initialDate);
        return;
      }
      const next = bookable.find((d) => d > initialDate);
      if (next) {
        setNotice(`${formatDay(initialDate)} has nothing free, so we have picked the next day we can do.`);
        setSelected(next);
        return;
      }
      setNotice(`${formatDay(initialDate)} has nothing free.`);
    }
    if (bookable.length > 0) {
      setSelected(bookable[0]);
      return;
    }
    if (!userNavigated.current && autoAdvanced.current < MAX_AUTO_ADVANCE && state.month < maxMonth) {
      autoAdvanced.current += 1;
      setMonth(addMonths(state.month, 1));
    }
  }, [state, selected, initialDate, maxMonth]);

  const go = (delta: number) => {
    userNavigated.current = true;
    setMonth((m) => addMonths(m, delta));
  };

  const lead = weekdayMon0(firstOfMonth(month));
  const daysInMonth = Number(lastOfMonth(month).slice(8));
  const bookable = state.kind === "ok" && state.month === month ? new Set(state.bookable) : new Set<string>();

  return (
    <section aria-labelledby="step-heading">
      <BackButton onClick={onBack} label="Change what you're booking" />
      <StepHeading hint={service.name}>Which day?</StepHeading>
      {notice ? <Notice kind="warning">{notice}</Notice> : null}

      <div className="rounded-xl border border-neutral-300 bg-white p-2 sm:p-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <Button variant="secondary" className="min-h-11! px-3!" disabled={month <= minMonth} onClick={() => go(-1)} aria-label="Previous month">
            <span aria-hidden="true">←</span>
          </Button>
          <p className="text-lg font-semibold" aria-live="polite">
            {formatMonth(month)}
          </p>
          <Button variant="secondary" className="min-h-11! px-3!" disabled={month >= maxMonth} onClick={() => go(1)} aria-label="Next month">
            <span aria-hidden="true">→</span>
          </Button>
        </div>

        <div className="grid grid-cols-7 gap-0.5 text-center text-xs font-medium text-neutral-600 sm:gap-1" aria-hidden="true">
          {WEEKDAYS.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
        <div role="group" aria-label={formatMonth(month)} className="mt-1 grid grid-cols-7 gap-0.5 sm:gap-1">
          {Array.from({ length: lead }, (_, i) => (
            <span key={`blank-${i}`} />
          ))}
          {Array.from({ length: daysInMonth }, (_, i) => {
            const date = `${month}-${String(i + 1).padStart(2, "0")}`;
            const ok = bookable.has(date);
            const isSelected = selected === date;
            return (
              <button
                key={date}
                type="button"
                disabled={!ok}
                aria-pressed={isSelected}
                aria-label={`${formatDay(date)}${ok ? "" : ", nothing free"}`}
                onClick={() => {
                  setSelected(date);
                  setNotice(null);
                }}
                className={`aspect-square min-h-11 w-full min-w-0 rounded-lg text-base tabular-nums ${
                  isSelected
                    ? "bg-neutral-900 font-bold text-white"
                    : ok
                      ? "border border-neutral-500 bg-white font-semibold text-neutral-950 hover:bg-neutral-100"
                      : "cursor-not-allowed text-neutral-400 line-through decoration-neutral-300"
                } ${date === today ? "underline underline-offset-4" : ""} ${focusRing}`}
              >
                {i + 1}
              </button>
            );
          })}
        </div>
        {state.kind === "loading" ? <Loading>Checking which days are free…</Loading> : null}
        {state.kind === "ok" && state.month === month && state.bookable.length === 0 ? (
          <p className="mt-3 text-neutral-800">Nothing free in {formatMonth(month)}. Try the next month.</p>
        ) : null}
        {opensOn && monthOf(opensOn) === month ? <p className="mt-3 text-sm text-neutral-700">We open on {formatDay(opensOn)}.</p> : null}
      </div>

      {state.kind === "error" ? (
        <Notice kind="error">
          <p>{state.message}</p>
          <Button variant="secondary" className="mt-3" onClick={() => setReload((n) => n + 1)}>
            Try again
          </Button>
        </Notice>
      ) : null}

      <Button className="mt-6 w-full" disabled={!selected} onClick={() => selected && onContinue(selected)}>
        {selected ? `Continue with ${formatDay(selected)}` : "Choose a day"}
      </Button>
    </section>
  );
}
