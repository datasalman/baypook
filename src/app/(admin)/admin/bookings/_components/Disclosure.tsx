import type { ReactNode } from "react";
import { buttonClasses, type ButtonVariant } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";

/**
 * A big button that opens a small form underneath (native <details>, works
 * without JavaScript). One idea per panel.
 */
export function Disclosure({
  label,
  children,
  variant = "secondary",
  open,
  id,
}: {
  label: ReactNode;
  children: ReactNode;
  variant?: ButtonVariant;
  open?: boolean;
  id?: string;
}) {
  return (
    <details id={id} open={open} className="group w-full rounded-2xl">
      <summary
        className={cn(
          buttonClasses({ variant, size: "lg", block: true }),
          "cursor-pointer list-none [&::-webkit-details-marker]:hidden",
        )}
      >
        {label}
        <span aria-hidden className="ml-auto text-base transition-transform group-open:rotate-180 motion-reduce:transition-none">
          ▾
        </span>
      </summary>
      <div className="mt-2 rounded-2xl border border-line bg-surface p-4">{children}</div>
    </details>
  );
}

/** Label/value rows for the detail sections. */
export function Facts({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="divide-y divide-line rounded-2xl border border-line bg-surface">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex flex-wrap justify-between gap-x-4 gap-y-1 px-4 py-3">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 text-right font-semibold [overflow-wrap:anywhere]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
