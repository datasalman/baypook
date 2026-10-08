"use client";

import Link from "next/link";
import { useState } from "react";
import { cn } from "./cn";

export type SegmentOption = { value: string; label: string; href?: string };

export type SegmentedControlProps = {
  options: SegmentOption[];
  /** Controlled value. Without it the control keeps its own state from `defaultValue`. */
  value?: string;
  defaultValue?: string;
  /** Form field name: a hidden input carries the value when submitted. */
  name?: string;
  onChange?: (value: string) => void;
  "aria-label": string;
  className?: string;
};

/**
 * A row of mutually exclusive choices. Options with `href` render as links
 * (navigation filters); otherwise as radio-like buttons.
 */
export function SegmentedControl({ options, value, defaultValue, name, onChange, className, ...rest }: SegmentedControlProps) {
  const [inner, setInner] = useState(defaultValue ?? options[0]?.value ?? "");
  const current = value ?? inner;
  const item = (active: boolean) =>
    cn(
      "flex min-h-11 flex-1 items-center justify-center rounded-lg px-3 text-sm font-semibold no-underline transition-colors",
      active ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink",
    );
  return (
    <div role="radiogroup" aria-label={rest["aria-label"]} className={cn("flex gap-1 rounded-xl bg-[#e6e9e2] p-1", className)}>
      {name ? <input type="hidden" name={name} value={current} /> : null}
      {options.map((o) =>
        o.href ? (
          <Link key={o.value} href={o.href} role="radio" aria-checked={o.value === current} className={item(o.value === current)}>
            {o.label}
          </Link>
        ) : (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === current}
            className={item(o.value === current)}
            onClick={() => {
              setInner(o.value);
              onChange?.(o.value);
            }}
          >
            {o.label}
          </button>
        ),
      )}
    </div>
  );
}
