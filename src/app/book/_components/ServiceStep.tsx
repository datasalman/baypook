"use client";

import { formatPence } from "@/client/client";
import type { Service } from "@/client/types";
import { formatLength } from "../_lib/dates";
import { BackButton, Button, focusRing, StepHeading } from "./ui";

export function priceLine(service: Service): string | null {
  if (service.options.length === 0) return null;
  if (service.kind === "session") {
    const lowest = Math.min(...service.options.map((o) => o.unitPricePence));
    return `From ${formatPence(lowest)}`;
  }
  const pkg = service.options[0];
  return pkg.includedChildren ? `${formatPence(pkg.unitPricePence)} for ${pkg.includedChildren} children` : formatPence(pkg.unitPricePence);
}

export function ServiceStep({
  venueName,
  services,
  kindFilter,
  selected,
  onSelect,
  onClearFilter,
  onBack,
}: {
  venueName: string;
  services: Service[];
  kindFilter: "session" | "slot" | null;
  selected: string | null;
  onSelect: (s: Service) => void;
  onClearFilter: () => void;
  onBack: () => void;
}) {
  const shown = kindFilter ? services.filter((s) => s.kind === kindFilter) : services;
  return (
    <section aria-labelledby="step-heading">
      <BackButton onClick={onBack} label="Change venue" />
      <StepHeading hint={venueName}>What are you booking?</StepHeading>
      {shown.length === 0 ? (
        <p className="text-neutral-800">Nothing can be booked online here yet. Message or call us and we will help.</p>
      ) : (
        <ul className="space-y-3">
          {shown.map((s) => {
            const price = priceLine(s);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  aria-pressed={selected === s.id}
                  onClick={() => onSelect(s)}
                  className={`w-full rounded-xl border border-neutral-400 bg-white p-4 text-left hover:border-neutral-900 ${
                    selected === s.id ? "ring-2 ring-neutral-900" : ""
                  } ${focusRing}`}
                >
                  <span className="block text-lg font-semibold">{s.name}</span>
                  {s.blurb ? <span className="mt-1 block text-neutral-700">{s.blurb}</span> : null}
                  <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium text-neutral-900">
                    <span>{formatLength(s.lengthMinutes)}</span>
                    {price ? <span>{price}</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {kindFilter && shown.length < services.length ? (
        <Button variant="quiet" className="mt-4" onClick={onClearFilter}>
          Show everything you can book here
        </Button>
      ) : null}
    </section>
  );
}
