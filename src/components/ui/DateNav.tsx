"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "./cn";

export type DateNavProps = {
  /** 'YYYY-MM-DD' currently shown (the day, or the first day of the week). */
  value: string;
  /** 'YYYY-MM-DD' today in the organisation timezone. */
  today: string;
  mode?: "day" | "week";
  /** Search param to drive: `date` for days, `start` for weeks. */
  param?: string;
  /** Human label for the current value, e.g. "Thursday 8 October". */
  label: string;
  className?: string;
};

function shift(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Previous / next day (or week), a date picker and a "Today" shortcut. Keeps other search params. */
export function DateNav({ value, today, mode = "day", param, label, className }: DateNavProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const key = param ?? (mode === "week" ? "start" : "date");
  const step = mode === "week" ? 7 : 1;

  const href = (date: string | null) => {
    const q = new URLSearchParams(params.toString());
    if (date) q.set(key, date);
    else q.delete(key);
    q.delete("flash");
    q.delete("flashKind");
    const qs = q.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  const unit = mode === "week" ? "week" : "day";
  const isCurrent = mode === "week" ? today >= value && today <= shift(value, 6) : value === today;
  const arrow =
    "flex min-h-12 min-w-12 items-center justify-center rounded-xl border-2 border-line bg-surface text-xl font-bold text-ink no-underline hover:border-ink/40";

  return (
    <nav aria-label={`Choose ${unit}`} className={cn("mb-4 flex items-center gap-2", className)}>
      <Link href={href(shift(value, -step))} className={arrow} aria-label={`Previous ${unit}`} scroll={false}>
        <span aria-hidden>‹</span>
      </Link>
      <div className="flex min-w-0 flex-1 flex-col items-center">
        <span className="truncate text-base font-bold" aria-live="polite">
          {label}
        </span>
        <div className="mt-0.5 flex items-center gap-2">
          <label className="sr-only" htmlFor="date-nav-input">
            Pick a date
          </label>
          <input
            id="date-nav-input"
            type="date"
            value={value}
            onChange={(e) => {
              if (e.target.value) router.push(href(e.target.value), { scroll: false });
            }}
            className="min-h-11 rounded-lg border border-line bg-surface px-2 text-sm"
          />
          {!isCurrent ? (
            <Link href={href(null)} className="flex min-h-11 items-center rounded-lg px-2 text-sm font-semibold text-brand-strong no-underline hover:underline">
              {mode === "week" ? "This week" : "Today"}
            </Link>
          ) : null}
        </div>
      </div>
      <Link href={href(shift(value, step))} className={arrow} aria-label={`Next ${unit}`} scroll={false}>
        <span aria-hidden>›</span>
      </Link>
    </nav>
  );
}
