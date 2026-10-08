/**
 * The three scheduled jobs shown on the Jobs page. Hold expiry lives in
 * `src/server/jobs.ts`. Reminders and retention come from
 * `src/server/jobs-reminders.ts` and `src/server/jobs-retention.ts`, which may
 * not exist yet: they are loaded on demand and the page shows "Not available yet"
 * until they do.
 */
import type { Db } from "@/db";
import { runExpireHoldsJob, runJob } from "@/server/jobs";
import type * as s from "@/db/schema";

export type JobKey = "expire-holds" | "reminders" | "retention";

export type JobDef = { key: JobKey; title: string; description: string; schedule: string };

export const JOBS: JobDef[] = [
  {
    key: "expire-holds",
    title: "Hold expiry",
    description: "Frees places held by customers who did not finish paying, and cancels their unpaid bookings.",
    schedule: "Every 5 minutes",
  },
  {
    key: "reminders",
    title: "Reminders",
    description: "Emails a reminder before each confirmed booking, once.",
    schedule: "Every hour",
  },
  {
    key: "retention",
    title: "Retention",
    description: "Anonymises old bookings and customers after the retention period in Settings.",
    schedule: "Every night",
  },
];

export function isJobKey(v: unknown): v is JobKey {
  return v === "expire-holds" || v === "reminders" || v === "retention";
}

type JobFn = (db: Db, now?: Date) => Promise<unknown>;

/** Load `<exportName>` from `src/server/jobs-<file>.ts`, or null when it is not there yet. */
async function loadOptional(file: "reminders" | "retention", exportName: string): Promise<JobFn | null> {
  try {
    // A template import so the build does not fail while the module does not exist yet.
    const mod: unknown = await import(`@/server/jobs-${file}`);
    const fn = mod && typeof mod === "object" ? (mod as Record<string, unknown>)[exportName] : undefined;
    return typeof fn === "function" ? (fn as JobFn) : null;
  } catch {
    return null;
  }
}

async function jobFn(key: Exclude<JobKey, "expire-holds">): Promise<JobFn | null> {
  return key === "reminders" ? loadOptional("reminders", "remindersJob") : loadOptional("retention", "retentionJob");
}

/** Which jobs can be run from here right now. */
export async function availableJobs(): Promise<Record<JobKey, boolean>> {
  const [reminders, retention] = await Promise.all([jobFn("reminders"), jobFn("retention")]);
  return { "expire-holds": true, reminders: Boolean(reminders), retention: Boolean(retention) };
}

/** Run a job now and record it in job_runs. Null when the job is not available yet. */
export async function runJobNow(db: Db, key: JobKey, triggeredBy: s.JobRun["triggeredBy"]): Promise<s.JobRun | null> {
  if (key === "expire-holds") return runExpireHoldsJob(db, triggeredBy);
  const fn = await jobFn(key);
  if (!fn) return null;
  return runJob(db, key, triggeredBy, () => fn(db));
}
