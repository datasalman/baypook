/**
 * Retention job (daily cron, or "Run now" on the Jobs page).
 *
 * After the organisation's `retentionMonths` (default 24, Settings):
 * - bookings that ended before the cutoff lose the free text that can hold
 *   personal data (customer message, internal notes, birthday child's name) and
 *   are stamped `anonymisedAt`. Money, dates and counts stay for the reports.
 * - customers with no booking left that is not anonymised (and who were created
 *   before the cutoff) become "Anonymised" with a dead placeholder address.
 * - Outbox rows (`notifications`, whose body snapshots hold names and addresses)
 *   and calendar log rows (whose payloads hold the same) older than the cutoff
 *   are deleted.
 * - The audit log is kept 12 months longer than everything else (it records who
 *   did what, which matters for disputes and refunds); rows older than
 *   cutoff − 12 months are deleted.
 *
 * Events already pushed to Google Calendar are not rewritten.
 */
import { and, eq, isNull, lt, notExists } from "drizzle-orm";
import { subMonths } from "date-fns";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";
import { getOrganisation } from "./org";

/** Extra months the audit log is kept beyond the retention period. */
export const AUDIT_EXTRA_MONTHS = 12;

export type RetentionSummary = {
  retentionMonths: number;
  cutoff: string;
  auditCutoff: string;
  bookingsAnonymised: number;
  customersAnonymised: number;
  notificationsDeleted: number;
  calendarLogDeleted: number;
  auditDeleted: number;
};

/** The placeholder e-mail an anonymised customer gets: unique, undeliverable. */
export function anonymisedEmail(customerId: string): string {
  return `anon-${customerId.replace(/-/g, "").slice(0, 8)}@anonymised.local`;
}

export async function retentionJob(db: DbOrTx, now: Date = new Date()): Promise<RetentionSummary> {
  const org = await getOrganisation(db);
  const months = Math.max(1, org.retentionMonths);
  const cutoff = subMonths(now, months);
  const auditCutoff = subMonths(cutoff, AUDIT_EXTRA_MONTHS);

  return db.transaction(async (tx) => {
    const bookings = await tx
      .update(s.bookings)
      .set({ customerMessage: null, notes: null, birthdayChildFirstName: null, anonymisedAt: now, updatedAt: now })
      .where(and(lt(s.bookings.endsAt, cutoff), isNull(s.bookings.anonymisedAt)))
      .returning({ id: s.bookings.id });

    const liveBookings = tx
      .select({ id: s.bookings.id })
      .from(s.bookings)
      .where(and(eq(s.bookings.customerId, s.customers.id), isNull(s.bookings.anonymisedAt)));
    const customers = await tx
      .select({ id: s.customers.id })
      .from(s.customers)
      .where(and(isNull(s.customers.anonymisedAt), lt(s.customers.createdAt, cutoff), notExists(liveBookings)));
    for (const c of customers) {
      await tx
        .update(s.customers)
        .set({
          firstName: "Anonymised",
          lastName: "",
          email: anonymisedEmail(c.id),
          phone: null,
          notes: null,
          anonymisedAt: now,
          updatedAt: now,
        })
        .where(eq(s.customers.id, c.id));
    }

    const notifications = await tx
      .delete(s.notifications)
      .where(lt(s.notifications.createdAt, cutoff))
      .returning({ id: s.notifications.id });
    const calendar = await tx
      .delete(s.calendarLog)
      .where(lt(s.calendarLog.createdAt, cutoff))
      .returning({ id: s.calendarLog.id });
    const audit = await tx.delete(s.auditLog).where(lt(s.auditLog.createdAt, auditCutoff)).returning({ id: s.auditLog.id });

    return {
      retentionMonths: months,
      cutoff: cutoff.toISOString(),
      auditCutoff: auditCutoff.toISOString(),
      bookingsAnonymised: bookings.length,
      customersAnonymised: customers.length,
      notificationsDeleted: notifications.length,
      calendarLogDeleted: calendar.length,
      auditDeleted: audit.length,
    };
  });
}
