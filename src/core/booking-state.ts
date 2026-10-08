/**
 * Booking state machine. Pure.
 *
 * pending   -> confirmed (payment webhook) | cancelled (expired or declined)
 * confirmed -> cancelled (admin, optional refund) | no_show
 * no_show   -> confirmed (undo a no-show)
 * cancelled -> confirmed (admin reinstates; the caller re-checks availability first)
 */
export type BookingStatus = "pending" | "confirmed" | "cancelled" | "no_show";

export const BOOKING_STATUSES: readonly BookingStatus[] = ["pending", "confirmed", "cancelled", "no_show"];

const ALLOWED: Record<BookingStatus, readonly BookingStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["cancelled", "no_show"],
  no_show: ["confirmed"],
  cancelled: ["confirmed"],
};

export class BookingStateError extends Error {
  from: BookingStatus;
  to: BookingStatus;
  constructor(from: BookingStatus, to: BookingStatus) {
    super(`A booking cannot go from ${from.replace("_", "-")} to ${to.replace("_", "-")}.`);
    this.name = "BookingStateError";
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export function assertTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransition(from, to)) throw new BookingStateError(from, to);
}

/** Statuses that hold places and block the room. */
export function holdsPlaces(status: BookingStatus): boolean {
  return status === "pending" || status === "confirmed";
}
