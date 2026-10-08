"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "./cn";

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const NAV_ICONS = {
  today: (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden {...stroke}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ),
  week: (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden {...stroke}>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18M8 2v4M16 2v4M8 13h2M14 13h2M8 17h2M14 17h2" />
    </svg>
  ),
  bookings: (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden {...stroke}>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" strokeWidth={3} />
    </svg>
  ),
  more: (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden {...stroke}>
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  ),
} satisfies Record<string, ReactNode>;

export type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  /** Path prefixes that also mark this item active. */
  match?: string[];
};

export const DEFAULT_NAV: NavItem[] = [
  { href: "/admin", label: "Today", icon: NAV_ICONS.today, match: ["/admin/sessions"] },
  { href: "/admin/week", label: "Week", icon: NAV_ICONS.week },
  { href: "/admin/bookings", label: "Bookings", icon: NAV_ICONS.bookings, match: ["/admin/customers"] },
  { href: "/admin/more", label: "More", icon: NAV_ICONS.more, match: ["/admin/"] },
];

function activeIndex(items: NavItem[], pathname: string): number {
  // Exact match first, then the longest prefix.
  let best = -1;
  let bestLen = -1;
  items.forEach((item, i) => {
    const candidates = [item.href, ...(item.match ?? [])];
    for (const c of candidates) {
      const hit = c === "/admin" ? pathname === "/admin" : pathname === c || pathname.startsWith(c.endsWith("/") ? c : `${c}/`);
      const len = c === item.href && pathname === c ? 10_000 : c.length;
      if (hit && len > bestLen) {
        best = i;
        bestLen = len;
      }
    }
  });
  return best;
}

/** Fixed bottom navigation for the admin: Today, Week, Bookings, More. */
export function BottomNav({ items = DEFAULT_NAV }: { items?: NavItem[] }) {
  const pathname = usePathname() ?? "/admin";
  const active = activeIndex(items, pathname);
  return (
    <nav aria-label="Main" className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur">
      <ul className="mx-auto flex max-w-3xl">
        {items.map((item, i) => {
          const on = i === active;
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "flex min-h-16 flex-col items-center justify-center gap-0.5 text-xs font-semibold no-underline",
                  on ? "text-brand-strong" : "text-muted hover:text-ink",
                )}
              >
                <span className={cn("flex h-8 w-14 items-center justify-center rounded-full", on && "bg-brand-soft")}>{item.icon}</span>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
