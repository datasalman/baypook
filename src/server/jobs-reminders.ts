/**
 * Reminders job (hourly cron, or "Run now" on the Jobs page).
 *
 * Every confirmed booking that starts within the organisation's
 * `reminderHoursBefore` window (and has not started yet) gets the "reminder"
 * email once per start time. The booking's `reminderSentAt` is the idempotency
 * guard: it is claimed with a conditional update before sending, so overlapping
 * runs never send two reminders. Moving a booking clears `reminderSentAt`, and
 * the moved booking must get a reminder for its new time, so the email is sent
 * WITHOUT `sendBookingEmail`'s dedupe (which matches on booking + template only
 * and would swallow the second reminder).
 *
 * Skipped (left for nobody): bookings made less than 2 hours before the start
 * (they have only just had their confirmation) and customers without a real
 * e-mail address (walk-ins with a placeholder, anonymised records).
 */
import { and, asc, eq, gt, isNull, lte } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";
import { getOrganisation } from "./org";
import { sendBookingEmail } from "./notifications";

/** A booking made this close to its start has just had its confirmation: no reminder. */
export const REMINDER_MIN_NOTICE_MS = 2 * 60 * 60_000;

export type RemindersSummary = {
  /** Bookings looked at (confirmed, starting inside the window, not yet reminded). */
  due: number;
  sent: number;
  skipped: number;
  failed: number;
  errors: string[];
};

/** True when the address is one we must not write to (blank, placeholder, anonymised). */
export function isUndeliverableEmail(email: string | null | undefined): boolean {
  const e = (email ?? "").trim().toLowerCase();
  if (!e || !e.includes("@")) return true;
  return e.endsWith(".local");
}

export async function remindersJob(db: DbOrTx, now: Date = new Date()): Promise<RemindersSummary> {
  const org = await getOrganisation(db);
  const hours = Math.max(0, org.reminderHoursBefore);
  const windowEnd = new Date(now.getTime() + hours * 60 * 60_000);
  const summary: RemindersSummary = { due: 0, sent: 0, skipped: 0, failed: 0, errors: [] };
  if (hours === 0) return summary;

  const due = await db
    .select({
      id: s.bookings.id,
      reference: s.bookings.reference,
      startsAt: s.bookings.startsAt,
      createdAt: s.bookings.createdAt,
      email: s.customers.email,
      customerAnonymisedAt: s.customers.anonymisedAt,
    })
    .from(s.bookings)
    .innerJoin(s.customers, eq(s.customers.id, s.bookings.customerId))
    .where(
      and(
        eq(s.bookings.status, "confirmed"),
        gt(s.bookings.startsAt, now),
        lte(s.bookings.startsAt, windowEnd),
        isNull(s.bookings.reminderSentAt),
        isNull(s.bookings.anonymisedAt),
      ),
    )
    .orderBy(asc(s.bookings.startsAt));

  summary.due = due.length;

  for (const b of due) {
    const lateBooking = b.startsAt.getTime() - b.createdAt.getTime() < REMINDER_MIN_NOTICE_MS;
    if (lateBooking || b.customerAnonymisedAt || isUndeliverableEmail(b.email)) {
      summary.skipped++;
      continue;
    }

    // Claim the booking first so a second run at the same moment leaves it alone.
    const claimed = await db
      .update(s.bookings)
      .set({ reminderSentAt: now })
      .where(and(eq(s.bookings.id, b.id), isNull(s.bookings.reminderSentAt)))
      .returning({ id: s.bookings.id });
    if (claimed.length === 0) {
      summary.skipped++;
      continue;
    }

    try {
      // No `dedupe`: the claim above is the guard (see the comment at the top).
      const n = await sendBookingEmail(db, { bookingId: b.id, template: "reminder", dedupe: false });
      if (n.status === "failed") throw new Error(n.error ?? "the email provider refused it");
      summary.sent++;
    } catch (e) {
      // Release the claim so the next hourly run tries again.
      await db.update(s.bookings).set({ reminderSentAt: null }).where(eq(s.bookings.id, b.id));
      summary.failed++;
      summary.errors.push(`${b.reference}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return summary;
}
