"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { getDb } from "@/db";
import { requireUser } from "@/server/auth";
import { createManualBooking, BookingError } from "@/server/bookings";
import { getService, isUuid } from "@/server/catalogue";
import { searchCustomers } from "@/server/customers";
import { getVenueById } from "@/server/org";
import { withFlash } from "@/components/ui/flash";
import { visibleCustomerIds } from "../../customers/_lib/customers";
import { bookingErrorMessage } from "../_lib/errors";
import { hasRealEmail } from "../_lib/labels";
import { amountField, field, quantitiesFromForm } from "../_lib/run";

export type CustomerHit = { id: string; firstName: string; lastName: string; email: string; phone: string | null };

/** Typeahead for the customer step: name, phone or email. */
export async function searchCustomersAction(q: string): Promise<CustomerHit[]> {
  const user = await requireUser("/admin/bookings/new");
  const term = String(q ?? "").trim().slice(0, 100);
  if (term.length < 2) return [];
  const db = await getDb();
  const rows = await searchCustomers(db, { q: term, limit: 40 });
  const visible = await visibleCustomerIds(
    db,
    user,
    rows.map((r) => r.id),
  );
  return rows
    .filter((r) => visible.has(r.id))
    .slice(0, 6)
    .map((r) => ({ id: r.id, firstName: r.firstName, lastName: r.lastName, email: hasRealEmail(r.email) ? r.email : "", phone: r.phone }));
}

export type NewBookingState = { error: string | null };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Create the walk-in or phone booking; used with useActionState so the form keeps its values on error. */
export async function createManualBookingAction(_prev: NewBookingState, fd: FormData): Promise<NewBookingState> {
  const user = await requireUser("/admin/bookings/new");
  const db = await getDb();
  let target = "";
  let message = "";
  try {
    const venueId = field(fd, "venueId");
    const serviceId = field(fd, "serviceId");
    const venue = isUuid(venueId) ? await getVenueById(db, venueId) : null;
    const service = isUuid(serviceId) ? await getService(db, serviceId) : null;
    if (!venue || !service || service.venueId !== venue.id) throw new BookingError("INVALID", "Choose the venue and service again.");

    const firstName = field(fd, "firstName").slice(0, 100);
    const lastName = field(fd, "lastName").slice(0, 100);
    const phone = field(fd, "phone").slice(0, 40);
    const noEmail = fd.get("noEmail") === "on";
    const email = noEmail ? "" : field(fd, "email").toLowerCase().slice(0, 200);
    if (!firstName) return { error: "Enter the parent's first name." };
    if (!noEmail && !email) return { error: "Enter an email for the confirmation, or tick “No email”." };
    if (email && !EMAIL_RE.test(email)) return { error: "That email does not look right." };

    const method = field(fd, "payment");
    if (method !== "cash" && method !== "card_machine" && method !== "pay_in_store") return { error: "Choose how they are paying." };
    const amountRaw = field(fd, "amount");
    let amountPence: number | null = null;
    if (method !== "pay_in_store" && amountRaw) {
      amountPence = amountField(fd, "amount");
      if (!Number.isInteger(amountPence)) return { error: "Enter the amount taken, for example 34.00, or leave it empty for the full total." };
    }

    const { lines, addOns } = quantitiesFromForm(fd);
    const sessionId = field(fd, "sessionId");
    const startsRaw = field(fd, "startsAt");
    const startsAt = startsRaw ? new Date(startsRaw) : null;

    const birthdayName = field(fd, "birthdayName").slice(0, 60);
    const ageRaw = field(fd, "birthdayAge");
    const age = ageRaw ? Number(ageRaw) : null;
    if (age !== null && (!Number.isInteger(age) || age < 0 || age > 18)) return { error: "Enter the birthday child's age as a number." };

    const sendEmail = !noEmail && hasRealEmail(email);
    const booking = await createManualBooking(db, {
      user,
      venue,
      service,
      sessionId: service.kind === "session" ? sessionId : null,
      startsAt: service.kind === "slot" && startsAt && !Number.isNaN(startsAt.getTime()) ? startsAt : null,
      lines,
      addOns,
      customer: { firstName, lastName, email: email || null, phone: phone || null },
      birthdayChild: service.kind === "slot" && (birthdayName || age !== null) ? { firstName: birthdayName, age } : null,
      notes: field(fd, "notes").slice(0, 5000) || null,
      payment: { method, amountPence },
      sendEmail,
    });
    target = `/admin/bookings/${booking.id}`;
    message = `Booking ${booking.reference} made${sendEmail ? `; confirmation sent to ${email}` : ""}`;
  } catch (e) {
    unstable_rethrow(e);
    return { error: bookingErrorMessage(e) };
  }
  revalidatePath("/admin", "layout");
  redirect(withFlash(target, message));
}
