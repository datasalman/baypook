import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "./cn";

export type PageHeaderProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Buttons shown beside (wide) or under (phone) the title. */
  actions?: ReactNode;
  /** Optional back link shown above the title. */
  back?: { href: string; label: string };
  className?: string;
};

export function PageHeader({ title, subtitle, actions, back, className }: PageHeaderProps) {
  return (
    <header className={cn("mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0">
        {back ? (
          <Link
            href={back.href}
            className="-ml-1 mb-1 inline-flex min-h-11 items-center gap-1 px-1 text-sm font-semibold text-brand-strong no-underline hover:underline"
          >
            <span aria-hidden>←</span> {back.label}
          </Link>
        ) : null}
        <h1 className="text-2xl font-bold leading-tight tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-base text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}
