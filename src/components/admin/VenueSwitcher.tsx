"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

export type VenueSwitcherProps = {
  venues: { id: string; name: string }[];
  selected: string;
  /** Owners get an "All venues" choice. */
  allowAll: boolean;
  /** The `selectVenue` server action. */
  action: (venueId: string) => Promise<{ ok: boolean }>;
};

/** A plain select in the top bar; changing it stores the choice and refreshes the page. */
export function VenueSwitcher({ venues, selected, allowAll, action }: VenueSwitcherProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <label className="flex items-center gap-2">
      <span className="sr-only">Venue</span>
      <select
        value={selected}
        disabled={pending}
        aria-busy={pending || undefined}
        onChange={(e) => {
          const id = e.target.value;
          start(async () => {
            await action(id);
            router.refresh();
          });
        }}
        className="min-h-11 max-w-[11rem] rounded-xl border-2 border-line bg-surface px-2 text-base font-semibold text-ink disabled:opacity-60"
      >
        {allowAll ? <option value="all">All venues</option> : null}
        {venues.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
    </label>
  );
}
