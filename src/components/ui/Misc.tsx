import type { ReactNode } from "react";
import { cn } from "./cn";

export type EmptyStateProps = {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
};

export function EmptyState({ title, children, action, className }: EmptyStateProps) {
  return (
    <div className={cn("rounded-2xl border-2 border-dashed border-line bg-surface/60 px-4 py-8 text-center", className)}>
      <p className="text-lg font-semibold">{title}</p>
      {children ? <div className="mx-auto mt-1 max-w-md text-muted">{children}</div> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export type StatProps = {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
};

export function Stat({ label, value, hint, className }: StatProps) {
  return (
    <div className={cn("rounded-2xl border border-line bg-surface p-4", className)}>
      <p className="text-sm font-semibold text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-sm text-muted">{hint}</p> : null}
    </div>
  );
}

export type BannerProps = {
  tone?: "warn" | "info" | "danger";
  children: ReactNode;
  className?: string;
};

/** A full-width notice. Amber `warn` is used for fallback warnings. */
export function Banner({ tone = "warn", children, className }: BannerProps) {
  const tones = {
    warn: "bg-warn-bg text-warn-ink border-warn-line",
    info: "bg-brand-soft text-ink border-brand/40",
    danger: "bg-danger-soft text-danger border-danger/40",
  } as const;
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("rounded-xl border px-3 py-2 text-sm font-medium", tones[tone], className)}>
      {children}
    </div>
  );
}

/** Section heading inside a page. */
export function SectionTitle({ children, className, aside }: { children: ReactNode; className?: string; aside?: ReactNode }) {
  return (
    <div className={cn("mb-2 mt-6 flex items-baseline justify-between gap-2", className)}>
      <h2 className="text-lg font-bold">{children}</h2>
      {aside ? <div className="text-sm text-muted">{aside}</div> : null}
    </div>
  );
}
