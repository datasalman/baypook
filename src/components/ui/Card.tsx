import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "./cn";

export type CardTone = "default" | "muted" | "block" | "warn";

const tones: Record<CardTone, string> = {
  default: "bg-surface border-line",
  muted: "bg-surface/70 border-line text-muted",
  block: "bg-[#eceeea] border-[#c9cdc5] text-[#3d423b]",
  warn: "bg-warn-bg border-warn-line text-warn-ink",
};

export type CardProps = {
  children: ReactNode;
  /** Makes the whole card a link (one big tap target). */
  href?: string;
  tone?: CardTone;
  /** Left accent bar colour, e.g. the service colour. */
  accent?: string | null;
  className?: string;
  as?: "div" | "section" | "article" | "li";
  "aria-label"?: string;
};

export function Card({ children, href, tone = "default", accent, className, as = "div", ...rest }: CardProps) {
  const classes = cn(
    "relative block rounded-2xl border p-4 shadow-[0_1px_0_rgba(0,0,0,0.03)]",
    tones[tone],
    accent && "pl-5",
    href && "no-underline text-inherit hover:border-ink/40 active:bg-canvas transition-colors",
    className,
  );
  const bar = accent ? (
    <span aria-hidden className="absolute inset-y-3 left-2 w-1.5 rounded-full" style={{ backgroundColor: accent }} />
  ) : null;
  if (href) {
    const link = (
      <Link href={href} className={classes} aria-label={rest["aria-label"]}>
        {bar}
        {children}
      </Link>
    );
    return as === "li" ? <li className="list-none">{link}</li> : link;
  }
  const Tag = as;
  return (
    <Tag className={classes} aria-label={rest["aria-label"]}>
      {bar}
      {children}
    </Tag>
  );
}
