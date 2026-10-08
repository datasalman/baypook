/** Words for booking fields, shared by the list, detail and customer pages. Pure. */
import type * as s from "@/db/schema";

export const PAYMENT_METHOD_LABEL: Record<s.Booking["paymentMethod"], string> = {
  online_card: "Card online",
  card_machine: "Card machine in store",
  cash: "Cash",
  pay_in_store: "To pay in store",
  imported: "Imported",
  none: "None",
};

export const LEDGER_METHOD_LABEL: Record<s.Payment["method"], string> = {
  online_card: "Card online",
  card_machine: "Card machine",
  cash: "Cash",
  imported: "Imported",
};

export const SOURCE_LABEL: Record<s.Booking["source"], string> = {
  online: "Booked online",
  manual: "Booked by staff",
  import: "Imported",
};

export const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "confirmed", label: "Confirmed" },
  { value: "pending", label: "Pending" },
  { value: "cancelled", label: "Cancelled" },
  { value: "no_show", label: "No-show" },
] as const;

export type StatusFilter = (typeof STATUS_FILTERS)[number]["value"];

export function statusFilter(v: string | undefined): StatusFilter {
  return STATUS_FILTERS.some((f) => f.value === v) ? (v as StatusFilter) : "all";
}

/** Customers who gave no e-mail are stored with a blank address. */
export function hasRealEmail(email: string | null | undefined): boolean {
  const e = (email ?? "").trim();
  return e.includes("@") && !e.endsWith(".local");
}

export function customerName(c: Pick<s.Customer, "firstName" | "lastName">): string {
  return `${c.firstName} ${c.lastName}`.trim() || "Customer";
}

/** "booking.change_counts" -> "Change counts" */
export function humaniseAction(action: string): string {
  const t = action.replace(/^booking\./, "").replace(/[._]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Money still to collect on a live booking (the service's "owed"). */
export function outstandingPence(b: Pick<s.Booking, "status" | "totalPence" | "paidPence">): number {
  if (b.status !== "confirmed" && b.status !== "no_show") return 0;
  return Math.max(b.totalPence - b.paidPence, 0);
}

/** Money paid beyond the current total (after places were reduced), for a refund hint. */
export function overpaidPence(b: Pick<s.Booking, "status" | "totalPence" | "paidPence" | "refundedPence">): number {
  if (b.status !== "confirmed" && b.status !== "no_show") return 0;
  return Math.max(b.paidPence - b.refundedPence - b.totalPence, 0);
}

export function refundablePence(b: Pick<s.Booking, "paidPence" | "refundedPence">): number {
  return Math.max(b.paidPence - b.refundedPence, 0);
}

/** 1750 -> "17.50" for an amount input. */
export function poundsValue(pence: number): string {
  return `${Math.floor(pence / 100)}.${String(pence % 100).padStart(2, "0")}`;
}
