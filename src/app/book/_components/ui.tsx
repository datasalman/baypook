"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "quiet";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-neutral-900 text-white hover:bg-neutral-700 disabled:bg-neutral-400",
  secondary: "border border-neutral-400 bg-white text-neutral-900 hover:bg-neutral-100 disabled:text-neutral-400",
  quiet: "text-neutral-800 underline underline-offset-4 hover:text-neutral-950 disabled:text-neutral-400",
};

const FOCUS = "focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-blue-700";

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const shape = variant === "quiet" ? "min-h-11 px-1" : "min-h-12 rounded-lg px-5 font-semibold";
  return (
    <button
      type="button"
      {...props}
      className={`${shape} ${VARIANTS[variant]} ${FOCUS} disabled:cursor-not-allowed ${className}`}
    />
  );
}

export function BackButton({ onClick, label = "Back" }: { onClick: () => void; label?: string }) {
  return (
    <Button variant="quiet" onClick={onClick} className="mb-2 -ml-1 text-sm">
      <span aria-hidden="true">← </span>
      {label}
    </Button>
  );
}

/** The step's main heading. BookFlow moves focus here when the step changes. */
export function StepHeading({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-5">
      <h2 id="step-heading" tabIndex={-1} className="text-2xl font-bold leading-tight outline-none">
        {children}
      </h2>
      {hint ? <p className="mt-1 text-neutral-700">{hint}</p> : null}
    </div>
  );
}

export function Notice({ kind = "info", children }: { kind?: "info" | "error" | "warning"; children: ReactNode }) {
  const styles = {
    info: "border-blue-300 bg-blue-50 text-blue-950",
    warning: "border-amber-400 bg-amber-50 text-amber-950",
    error: "border-red-400 bg-red-50 text-red-950",
  }[kind];
  return (
    <div role={kind === "error" ? "alert" : "status"} className={`my-4 rounded-lg border px-4 py-3 ${styles}`}>
      {children}
    </div>
  );
}

export function Loading({ children = "Loading…" }: { children?: ReactNode }) {
  return (
    <p role="status" className="my-6 flex items-center gap-3 text-neutral-700">
      <span
        aria-hidden="true"
        className="inline-block h-4 w-4 rounded-full border-2 border-neutral-400 border-t-neutral-900 motion-safe:animate-spin"
      />
      {children}
    </p>
  );
}

export function Stepper({
  id,
  label,
  value,
  min = 0,
  max,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: number;
  min?: number;
  max: number;
  onChange: (value: number) => void;
  children?: ReactNode;
}) {
  const btn = `h-11 w-11 shrink-0 rounded-full border border-neutral-500 bg-white text-xl font-bold leading-none hover:bg-neutral-100 disabled:border-neutral-300 disabled:text-neutral-300 ${FOCUS}`;
  return (
    <div className="flex items-start justify-between gap-4 border-b border-neutral-200 py-4 last:border-b-0">
      <div className="min-w-0">
        <p id={`${id}-label`} className="font-semibold">
          {label}
        </p>
        {children ? <div className="mt-1 text-sm text-neutral-700">{children}</div> : null}
      </div>
      <div className="flex items-center gap-2" role="group" aria-labelledby={`${id}-label`}>
        <button type="button" className={btn} aria-label={`One fewer: ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}>
          −
        </button>
        <output aria-live="polite" className="w-8 text-center text-lg font-semibold tabular-nums">
          {value}
        </output>
        <button type="button" className={btn} aria-label={`One more: ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}>
          +
        </button>
      </div>
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-neutral-300 bg-white p-4 ${className}`}>{children}</div>;
}

export const focusRing = FOCUS;
