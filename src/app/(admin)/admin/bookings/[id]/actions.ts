"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as s from "@/db/schema";
import { fmtPence } from "@/core/time";
import { requireUser } from "@/server/auth";
import { isUuid } from "@/server/catalogue";
import {
  addBookingNote,
  BookingError,
  cancelBooking,
  changeBookingCounts,
  markNoShow,
  markPaidInStore,
  moveBooking,
  refundBooking,
  resendConfirmation,
} from "@/server/bookings";
import { withFlash } from "@/components/ui/flash";
import { bookingErrorMessage } from "../_lib/errors";
import { amountField, field, quantitiesFromForm, runBookingAction } from "../_lib/run";

function bookingId(fd: FormData): string {
  const id = field(fd, "bookingId");
  return isUuid(id) ? id : "";
}

const detailPath = (id: string) => (id ? `/admin/bookings/${id}` : "/admin/bookings");

/** Cancel, optionally with a full or part refund first. */
export async function cancelBookingAction(fd: FormData): Promise<void> {
  const id = bookingId(fd);
  await runBookingAction(detailPath(id), async ({ db, user }) => {
    if (!id) throw new BookingError("NOT_FOUND", "We could not find that booking.");
    const reason = field(fd, "reason").slice(0, 500);
    const choice = field(fd, "refund");
    let refundPence = 0;
    if (choice === "full") {
      const [b] = await db.select().from(s.bookings).where(eq(s.bookings.id, id)).limit(1);
      if (!b) throw new BookingError("NOT_FOUND", "We could not find that booking.");
      refundPence = Math.max(b.paidPence - b.refundedPence, 0);
    } else if (choice === "part") {
      refundPence = amountField(fd, "partAmount");
      if (!Number.isInteger(refundPence) || refundPence < 1) {
        throw new BookingError("INVALID", "Enter the amount to refund, for example 17.50.");
      }
    }
    await cancelBooking(db, {
      bookingId: id,
      user,
      reason: reason || "Cancelled by staff",
      refund: refundPence > 0 ? { amountPence: refundPence } : null,
    });
    return refundPence > 0 ? `Booking cancelled and ${fmtPence(refundPence)} refunded` : "Booking cancelled";
  });
}

export async function refundBookingAction(fd: FormData): Promise<void> {
  const id = bookingId(fd);
  await runBookingAction(detailPath(id), async ({ db, user }) => {
    if (!id) throw new BookingError("NOT_FOUND", "We could not find that booking.");
    const amount = amountField(fd, "amount");
    if (!Number.isInteger(amount) || amount < 1) throw new BookingError("INVALID", "Enter the amount to refund, for example 17.50.");
    const refund = await refundBooking(db, { bookingId: id, user, amountPence: amount, reason: field(fd, "reason").slice(0, 500) });
    return refund.status === "pending" ? `Refund of ${fmtPence(amount)} requested: it shows as done once the card provider confirms` : `Refunded ${fmtPence(amount)}`;
  });
}

export async function markPaidAction(fd: FormData): Promise<void> {
  const id = bookingId(fd);
  await runBookingAction(detailPath(id), async ({ db, user }) => {
    if (!id) throw new BookingError("NOT_FOUND", "We could not find that booking.");
    const method = field(fd, "method");
    if (method !== "cash" && method !== "card_machine") throw new BookingError("INVALID", "Choose cash or card machine.");
    const amount = amountField(fd, "amount");
    if (!Number.isInteger(amount) || amount < 1) throw new BookingError("INVALID", "Enter the amount taken, for example 17.50.");
    await markPaidInStore(db, { bookingId: id, user, method, amountPence: amount });
    return `${fmtPence(amount)} paid in store recorded`;
  });
}

export async function noShowAction(fd: FormData): Promise<void> {
  const id = bookingId(fd);
  const undo = field(fd, "undo") === "1";
  await runBookingAction(detailPath(id), async ({ db, user }) => {
    if (!id) throw new BookingError("NOT_FOUND", "We could not find that booking.");
    await markNoShow(db, { bookingId: id, user, undo });
    return undo ? "No-show undone: the booking is confirmed again" : "Marked as a no-show";
  });
}

export async function resendConfirmationAction(fd: FormData): Promise<void> {
  const id = bookingId(fd);
  await runBookingAction(detailPath(id), async ({ db, user }) => {
    if (!id) throw new BookingError("NOT_FOUND", "We could not find that booking.");
    const n = await resendConfirmation(db, { bookingId: id, user });
    if (n.status === "failed") return { message: `Could not send to ${n.toAddress}: ${n.error ?? "unknown error"}`, kind: "error" };
    if (n.status === "demo") return `Confirmation written to the Outbox for ${n.toAddress} (demo: not sent)`;
    return `Confirmation sent to ${n.toAddress}`;
  });
}

export async function saveNoteAction(fd: FormData): Promise<void> {
  const id = bookingId(fd);
  await runBookingAction(`${detailPath(id)}#notes`, async ({ db, user }) => {
    if (!id) throw new BookingError("NOT_FOUND", "We could not find that booking.");
    const raw = fd.get("notes");
    await addBookingNote(db, { bookingId: id, user, notes: typeof raw === "string" ? raw : "" });
    return "Notes saved";
  });
}

/** Move to a session (`sessionId`) or a slot start (`startsAt`, ISO). */
export async function moveBookingAction(fd: FormData): Promise<void> {
  const id = bookingId(fd);
  const back = field(fd, "back").startsWith(`/admin/bookings/${id}/move`) && id ? field(fd, "back") : `${detailPath(id)}/move`;
  await runBookingAction(back, async ({ db, user }) => {
    if (!id) throw new BookingError("NOT_FOUND", "We could not find that booking.");
    const sessionId = field(fd, "sessionId");
    const startsRaw = field(fd, "startsAt");
    const startsAt = startsRaw ? new Date(startsRaw) : null;
    await moveBooking(db, {
      bookingId: id,
      user,
      sessionId: sessionId || null,
      startsAt: startsAt && !Number.isNaN(startsAt.getTime()) ? startsAt : null,
    });
    return { message: "Booking moved. The parent gets a fresh confirmation email.", to: detailPath(id) };
  });
}

export type ChangeCountsState = { error: string | null };

/** Used with useActionState: errors come back to the form so the choices are kept. */
export async function changeCountsAction(_prev: ChangeCountsState, fd: FormData): Promise<ChangeCountsState> {
  const id = bookingId(fd);
  if (!id) return { error: "We could not find that booking." };
  const user = await requireUser(`/admin/bookings/${id}/change`);
  const db = await getDb();
  let delta = 0;
  try {
    const { lines, addOns } = quantitiesFromForm(fd);
    const r = await changeBookingCounts(db, { bookingId: id, user, lines, addOns });
    delta = r.delta;
  } catch (e) {
    unstable_rethrow(e);
    return { error: bookingErrorMessage(e) };
  }
  revalidatePath("/admin", "layout");
  const message =
    delta > 0
      ? `Saved. To collect in store: ${fmtPence(delta)}`
      : delta < 0
        ? `Saved. They have paid ${fmtPence(-delta)} more than the new total: give a refund of ${fmtPence(-delta)}?`
        : "Saved. Nothing more to pay.";
  redirect(withFlash(`/admin/bookings/${id}`, message));
}
