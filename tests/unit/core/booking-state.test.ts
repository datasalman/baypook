import { describe, expect, it } from "vitest";
import { assertTransition, BOOKING_STATUSES, BookingStateError, canTransition, holdsPlaces, type BookingStatus } from "@/core/booking-state";

const ALLOWED: [BookingStatus, BookingStatus][] = [
  ["pending", "confirmed"],
  ["pending", "cancelled"],
  ["confirmed", "cancelled"],
  ["confirmed", "no_show"],
  ["no_show", "confirmed"],
  ["cancelled", "confirmed"],
];

describe("booking state machine", () => {
  const table = BOOKING_STATUSES.flatMap((from) => BOOKING_STATUSES.map((to) => [from, to] as const));

  it.each(table)("%s -> %s", (from, to) => {
    const allowed = ALLOWED.some(([f, t]) => f === from && t === to);
    expect(canTransition(from, to)).toBe(allowed);
    if (allowed) expect(() => assertTransition(from, to)).not.toThrow();
    else expect(() => assertTransition(from, to)).toThrow(BookingStateError);
  });

  it("explains a refused transition in plain words", () => {
    try {
      assertTransition("no_show", "cancelled");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BookingStateError);
      expect((e as BookingStateError).from).toBe("no_show");
      expect((e as BookingStateError).to).toBe("cancelled");
      expect((e as Error).message).toBe("A booking cannot go from no-show to cancelled.");
    }
  });

  it("rejects unknown statuses", () => {
    expect(canTransition("archived" as BookingStatus, "confirmed")).toBe(false);
  });

  it("only pending and confirmed bookings hold places", () => {
    expect(BOOKING_STATUSES.filter(holdsPlaces)).toEqual(["pending", "confirmed"]);
  });
});
