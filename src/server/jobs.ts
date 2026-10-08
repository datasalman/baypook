/**
 * Scheduled jobs. Every run is recorded in `job_runs` (shown on the admin Jobs page).
 * Cron routes call these through `runJob`; the admin's "Run now" does the same with
 * `triggeredBy: "admin"`.
 */
import { desc, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";
import { getPaymentProvider } from "@/providers";
import { expireHolds } from "./holds";
import { cancelPendingBooking } from "./bookings";

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
 */
export async function expireHoldsJob(db: DbOrTx, now: Date = new Date()): Promise<ExpireHoldsSummary> {
  const res = await expireHolds(db, now);
  const summary: ExpireHoldsSummary = { expired: res.expired, bookingsCancelled: 0, checkoutsExpired: 0, errors: [] };

  for (const bookingId of res.bookingIds) {
    try {
      const [b] = await db.select({ status: s.bookings.status }).from(s.bookings).where(eq(s.bookings.id, bookingId)).limit(1);
      if (b?.status === "pending") {
        await cancelPendingBooking(db, { bookingId, reason: "expired" });
        summary.bookingsCancelled++;
      }
    } catch (e) {
      summary.errors.push(`booking ${bookingId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (res.checkoutIds.length) {
    const rows = await db
      .select({ checkoutId: s.holds.checkoutId, slug: s.venues.slug })
      .from(s.holds)
      .innerJoin(s.venues, eq(s.venues.id, s.holds.venueId))
      .where(inArray(s.holds.checkoutId, res.checkoutIds));
    const slugByCheckout = new Map(rows.filter((r) => r.checkoutId).map((r) => [r.checkoutId as string, r.slug]));
    for (const checkoutId of res.checkoutIds) {
      const slug = slugByCheckout.get(checkoutId);
      if (!slug) continue;
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
  }
  return summary;
}

/** Convenience for the admin "Run now" button and cron. */
export function runExpireHoldsJob(db: DbOrTx, triggeredBy: JobTrigger, now?: Date): Promise<s.JobRun> {
  return runJob(db, "expire-holds", triggeredBy, () => expireHoldsJob(db, now));
}

export async function listJobRuns(db: DbOrTx, opts: { limit?: number; job?: string } = {}): Promise<s.JobRun[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  return db
    .select()
    .from(s.jobRuns)
    .where(opts.job ? eq(s.jobRuns.job, opts.job) : undefined)
    .orderBy(desc(s.jobRuns.startedAt))
    .limit(limit);
}
