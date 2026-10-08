/**
 * Scheduled jobs. Every run is recorded in `job_runs` (shown on the admin Jobs page).
 * Cron routes call these through `runJob`; the admin's "Run now" does the same with
 * `triggeredBy: "admin"`.
 */
import { and, desc, eq, gte, lt, lte, ne, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";
import { getPaymentProvider } from "@/providers";
import { cancelPendingBookingInTx } from "./bookings";

export type JobTrigger = s.JobRun["triggeredBy"];

/** Record a run: `running`, then `ok` with the summary or `failed` with the error. Never throws for job errors. */
export async function runJob<T>(db: DbOrTx, name: string, triggeredBy: JobTrigger, fn: () => Promise<T>): Promise<s.JobRun> {
  const [run] = await db.insert(s.jobRuns).values({ job: name, triggeredBy, status: "running" }).returning();
  try {
    const summary = await fn();
    const [done] = await db
      .update(s.jobRuns)
      .set({ status: "ok", summary: JSON.parse(JSON.stringify(summary ?? null)) as unknown, finishedAt: new Date() })
      .where(eq(s.jobRuns.id, run.id))
      .returning();
    return done ?? run;
  } catch (e) {
    console.error(`[jobs] ${name} failed:`, e);
    const [failed] = await db
      .update(s.jobRuns)
      .set({ status: "failed", error: e instanceof Error ? e.message : String(e), finishedAt: new Date() })
      .where(eq(s.jobRuns.id, run.id))
      .returning();
    return failed ?? run;
  }
}

export type ExpireHoldsSummary = {
  expired: number;
  bookingsCancelled: number;
  checkoutsExpired: number;
  errors: string[];
};

/**
 * Expire lapsed holds, cancel the pending bookings made from them (so the places
 * are free again) and tell the payment provider to close their checkouts.
 *
 * Each hold is expired together with its pending booking in one transaction, so
 * a crash between the two cannot leave a pending booking holding places with no
 * live hold. A sweep then cancels any pending booking already in that state
 * (its hold is no longer active and its expiry has passed).
 */
export async function expireHoldsJob(db: DbOrTx, now: Date = new Date()): Promise<ExpireHoldsSummary> {
  const summary: ExpireHoldsSummary = { expired: 0, bookingsCancelled: 0, checkoutsExpired: 0, errors: [] };
  const checkouts: { checkoutId: string; slug: string }[] = [];

  const lapsed = await db
    .select({ id: s.holds.id, slug: s.venues.slug })
    .from(s.holds)
    .innerJoin(s.venues, eq(s.venues.id, s.holds.venueId))
    .where(and(eq(s.holds.status, "active"), lte(s.holds.expiresAt, now)));

  for (const row of lapsed) {
    try {
      const res = await db.transaction(async (tx) => {
        const [hold] = await tx.select().from(s.holds).where(eq(s.holds.id, row.id)).for("update");
        if (!hold || hold.status !== "active" || hold.expiresAt.getTime() > now.getTime()) return null;
        let cancelled = false;
        // The booking's own open payment pages too (a pending payment row whose page never reached the hold).
        let bookingCheckoutIds: string[] = [];
        if (hold.bookingId) {
          const r = await cancelPendingBookingInTx(tx, { bookingId: hold.bookingId, reason: "expired" });
          cancelled = r.cancelled;
          bookingCheckoutIds = r.checkoutIds;
        }
        await tx.update(s.holds).set({ status: "expired" }).where(eq(s.holds.id, hold.id));
        return { checkoutIds: [hold.checkoutId, ...bookingCheckoutIds].filter((x): x is string => Boolean(x)), cancelled };
      });
      if (!res) continue;
      summary.expired++;
      if (res.cancelled) summary.bookingsCancelled++;
      for (const checkoutId of res.checkoutIds) checkouts.push({ checkoutId, slug: row.slug });
    } catch (e) {
      summary.errors.push(`hold ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Sweep: pending bookings whose hold already ended (e.g. expired by an older run that stopped half-way).
  const stranded = await db
    .select({ bookingId: s.bookings.id, checkoutId: s.holds.checkoutId, slug: s.venues.slug })
    .from(s.bookings)
    .innerJoin(s.holds, eq(s.holds.id, s.bookings.holdId))
    .innerJoin(s.venues, eq(s.venues.id, s.bookings.venueId))
    .where(and(eq(s.bookings.status, "pending"), ne(s.holds.status, "active"), lte(s.holds.expiresAt, now)));
  for (const row of stranded) {
    try {
      const res = await db.transaction((tx) => cancelPendingBookingInTx(tx, { bookingId: row.bookingId, reason: "expired" }));
      if (res.cancelled) {
        summary.bookingsCancelled++;
        for (const checkoutId of res.checkoutIds) checkouts.push({ checkoutId, slug: row.slug });
      }
    } catch (e) {
      summary.errors.push(`booking ${row.bookingId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const seen = new Set<string>();
  for (const { checkoutId, slug } of checkouts) {
    if (seen.has(checkoutId)) continue;
    seen.add(checkoutId);
    try {
      const resolved = await getPaymentProvider(slug);
      if (resolved) {
        await resolved.provider.expireCheckout(checkoutId);
        summary.checkoutsExpired++;
      }
    } catch (e) {
      summary.errors.push(`checkout ${checkoutId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return summary;
}

/** Convenience for the admin "Run now" button and cron. */
export function runExpireHoldsJob(db: DbOrTx, triggeredBy: JobTrigger, now?: Date): Promise<s.JobRun> {
  return runJob(db, "expire-holds", triggeredBy, () => expireHoldsJob(db, now));
}

export async function listJobRuns(
  db: DbOrTx,
  opts: { limit?: number; job?: string; /** Runs started at or after this instant. */ from?: Date; /** Runs started before this instant (exclusive). */ to?: Date } = {},
): Promise<s.JobRun[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const where: SQL[] = [];
  if (opts.job) where.push(eq(s.jobRuns.job, opts.job));
  if (opts.from) where.push(gte(s.jobRuns.startedAt, opts.from));
  if (opts.to) where.push(lt(s.jobRuns.startedAt, opts.to));
  return db
    .select()
    .from(s.jobRuns)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(s.jobRuns.startedAt))
    .limit(limit);
}
