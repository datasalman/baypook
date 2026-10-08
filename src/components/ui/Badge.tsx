import type { ReactNode } from "react";
import { cn } from "./cn";

export type BadgeTone = "green" | "amber" | "grey" | "red" | "blue" | "brand";

const tones: Record<BadgeTone, string> = {
  green: "bg-[#dcf3d3] text-[#1e5b10] border-[#a9dc95]",
  amber: "bg-[#fff1c7] text-[#6b4a00] border-[#ecc860]",
  grey: "bg-[#eceeea] text-[#454a43] border-[#cdd1c9]",
  red: "bg-[#fde3e0] text-[#8f1d13] border-[#f2a59c]",
  blue: "bg-[#e1ecfd] text-[#1d4a8f] border-[#a8c4f0]",
  brand: "bg-brand-soft text-brand-strong border-brand/40",
};

/** Booking and payment statuses with their plain-words label and colour. */
export const STATUS_BADGES = {
  confirmed: { label: "Confirmed", tone: "green" },
  pending: { label: "Pending", tone: "amber" },
  cancelled: { label: "Cancelled", tone: "grey" },
  no_show: { label: "No-show", tone: "red" },
  owed: { label: "Owed", tone: "amber" },
  paid: { label: "Paid", tone: "green" },
  unpaid: { label: "Not paid", tone: "amber" },
  refunded: { label: "Refunded", tone: "grey" },
  partially_refunded: { label: "Part refunded", tone: "blue" },
  full: { label: "Full", tone: "red" },
  scheduled: { label: "On", tone: "green" },
  disputed: { label: "Disputed", tone: "red" },
  failed: { label: "Failed", tone: "red" },
  demo: { label: "Demo", tone: "blue" },
  sent: { label: "Sent", tone: "green" },
  queued: { label: "Queued", tone: "amber" },
} as const satisfies Record<string, { label: string; tone: BadgeTone }>;

export type BadgeStatus = keyof typeof STATUS_BADGES;

export type BadgeProps = {
  /** A known status: picks the label and colour. */
  status?: BadgeStatus;
  tone?: BadgeTone;
  children?: ReactNode;
  className?: string;
};

export function Badge({ status, tone, children, className }: BadgeProps) {
  const preset = status ? STATUS_BADGES[status] : undefined;
  const t: BadgeTone = tone ?? preset?.tone ?? "grey";
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-sm font-semibold leading-5",
        tones[t],
        className,
      )}
    >
      {children ?? preset?.label}
    </span>
  );
}
