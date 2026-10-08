"use client";

import type { Venue } from "@/client/types";
import { formatOpens } from "../_lib/dates";
import { focusRing, StepHeading } from "./ui";

export function VenueStep({ venues, selected, onSelect }: { venues: Venue[]; selected: string | null; onSelect: (v: Venue) => void }) {
  return (
    <section aria-labelledby="step-heading">
      <StepHeading>Where would you like to come?</StepHeading>
      <ul className="space-y-3">
        {venues.map((v) => {
          const opening = v.status === "opening" && v.opensAt;
          return (
            <li key={v.slug}>
              <button
                type="button"
                disabled={!v.onlineBookable}
                aria-pressed={selected === v.slug}
                onClick={() => onSelect(v)}
                className={`w-full rounded-xl border bg-white p-4 text-left ${
                  v.onlineBookable ? "border-neutral-400 hover:border-neutral-900" : "cursor-not-allowed border-neutral-200 bg-neutral-50"
                } ${selected === v.slug ? "ring-2 ring-neutral-900" : ""} ${focusRing}`}
              >
                <span className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-lg font-semibold">{v.name}</span>
                  {opening ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-sm font-medium text-amber-950">
                      Opens {formatOpens(v.opensAt as string, v.timezone)}
                    </span>
                  ) : null}
                </span>
                <span className="mt-1 block text-neutral-700">{v.address}</span>
                {!v.onlineBookable ? <span className="mt-2 block font-medium text-neutral-800">Online booking is not available here yet.</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-6 text-sm text-neutral-700">Walk-ins are welcome for workshops. Parties must be booked.</p>
    </section>
  );
}
