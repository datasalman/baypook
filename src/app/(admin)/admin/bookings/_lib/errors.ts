/**
 * Plain-words messages for the booking admin. Booking service errors already
 * carry a friendly message; anything unexpected is logged and never shown.
 */
import { BookingError, toBookingError } from "@/server/bookings";
import { AuthError } from "@/server/auth";

export function bookingErrorMessage(e: unknown): string {
  const err = toBookingError(e);
  if (err instanceof BookingError) {
    switch (err.code) {
      case "FORBIDDEN":
        return err.message || "You do not have permission to do that.";
      case "NOT_FOUND":
        return err.message || "We could not find that booking.";
      case "LIMIT":
        if (err.message) return err.message;
        return err.limit !== undefined ? `The most you can choose is ${err.limit}.` : "That is more than allowed.";
      default:
        return err.message || "That did not work. Please check and try again.";
    }
  }
  if (e instanceof AuthError) return e.message;
  console.error("[admin bookings] unexpected error", e);
  return "Something went wrong. Please try again.";
}

