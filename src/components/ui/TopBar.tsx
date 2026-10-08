import Link from "next/link";
import type { ReactNode } from "react";

export type TopBarProps = {
  title: ReactNode;
  /** Where the title links to. */
  href?: string;
  /** Right-hand slot: the venue switcher, a menu link… */
  right?: ReactNode;
};

/** Sticky top bar: organisation name on the left, venue switcher on the right. */
export function TopBar({ title, href = "/admin", right }: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      <div className="mx-auto flex min-h-14 max-w-3xl items-center gap-3 px-4">
        <Link href={href} className="flex min-h-11 min-w-0 items-center gap-2 font-bold text-ink no-underline">
          <span aria-hidden className="inline-block h-6 w-6 shrink-0 rounded-md bg-brand" />
          <span className="truncate text-lg">{title}</span>
        </Link>
        <div className="ml-auto flex shrink-0 items-center gap-2">{right}</div>
      </div>
    </header>
  );
}
