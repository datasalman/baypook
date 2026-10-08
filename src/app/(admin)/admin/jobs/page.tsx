import type { Metadata } from "next";
import { fmtLocal } from "@/core/time";
import type * as s from "@/db/schema";
import { isDemo } from "@/lib/env";
import { listJobRuns } from "@/server/jobs";
import { getAdminContext } from "@/server/venue-scope";
import { Badge, Banner, Button, EmptyState, PageHeader, SectionTitle } from "@/components/ui";
import { JOBS, availableJobs } from "./registry";
import { runJobAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Jobs" };

const TRIGGER: Record<s.JobRun["triggeredBy"], string> = { cron: "on schedule", admin: "by hand", test: "test" };

function StatusBadge({ status }: { status: s.JobRun["status"] }) {
  if (status === "ok") return <Badge tone="green">Done</Badge>;
  if (status === "running") return <Badge tone="amber">Running</Badge>;
  return <Badge status="failed" />;
}

/** `{ expired: 2, bookingsCancelled: 1, errors: [] }` -> "Expired 2 · Bookings cancelled 1" */
function summaryText(summary: unknown): string {
  if (summary === null || summary === undefined) return "";
  if (typeof summary !== "object") return String(summary);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(summary as Record<string, unknown>)) {
    const label = k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
    const nice = label.charAt(0).toUpperCase() + label.slice(1);
    if (Array.isArray(v)) {
      if (v.length) parts.push(`${nice} ${v.length}`);
    } else if (v === null || typeof v !== "object") {
      parts.push(`${nice} ${String(v)}`);
    }
  }
  return parts.join(" · ");
}

export default async function JobsPage() {
  const ctx = await getAdminContext();
  const tz = ctx.org.timezone;
  const canRun = ctx.user.isOwner || ctx.user.venues.some((v) => v.role === "manager");
  const [runs, available, ...lastRuns] = await Promise.all([
    listJobRuns(ctx.db, { limit: 50 }),
    availableJobs(),
    ...JOBS.map((j) => listJobRuns(ctx.db, { job: j.key, limit: 1 })),
  ]);
  const title = new Map(JOBS.map((j) => [j.key as string, j.title]));
  const when = (d: Date) => fmtLocal(d, "EEE d MMM, HH:mm:ss", tz);

  return (
    <>
      <PageHeader title="Jobs" subtitle="Work BayPook does on a timer. You can also run each one now." />
      {isDemo() ? (
        <Banner tone="info" className="mb-4">
          Demo mode: nothing runs on a timer. Use Run now to try each job.
        </Banner>
      ) : null}

      <div className="grid gap-3">
        {JOBS.map((job, i) => {
          const last = lastRuns[i]?.[0];
          const ready = available[job.key];
          return (
            <section key={job.key} className="rounded-2xl border border-line bg-surface p-4" aria-labelledby={`job-${job.key}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h2 id={`job-${job.key}`} className="text-lg font-bold">
                  {job.title}
                </h2>
                {last ? <StatusBadge status={last.status} /> : <Badge tone="grey">Not run yet</Badge>}
              </div>
              <p className="mt-1 text-muted">{job.description}</p>
              <p className="mt-1 text-sm text-muted">{job.schedule}</p>
              {last ? (
                <p className="mt-2 text-sm">
                  Last run {when(last.startedAt)} ({TRIGGER[last.triggeredBy]})
                  {summaryText(last.summary) ? `: ${summaryText(last.summary)}` : ""}
                </p>
              ) : null}
              {last?.error ? <p className="mt-1 break-words text-sm font-semibold text-danger">{last.error}</p> : null}
              <div className="mt-3">
                {!ready ? (
                  <Button disabled variant="secondary">
                    Run now (coming soon)
                  </Button>
                ) : canRun ? (
                  <form action={runJobAction}>
                    <input type="hidden" name="job" value={job.key} />
                    <Button type="submit" variant="secondary">
                      Run now
                    </Button>
                  </form>
                ) : (
                  <p className="text-sm text-muted">The owner or a manager can run this now.</p>
                )}
              </div>
            </section>
          );
        })}
      </div>

      <SectionTitle aside="Newest first">Last 50 runs</SectionTitle>
      {runs.length === 0 ? (
        <EmptyState title="No runs yet" />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {runs.map((r) => (
            <li key={r.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">{title.get(r.job) ?? r.job}</span>
                <StatusBadge status={r.status} />
              </div>
              <p className="text-sm text-muted">
                {when(r.startedAt)} · {TRIGGER[r.triggeredBy]}
                {r.finishedAt ? ` · took ${Math.max(0, r.finishedAt.getTime() - r.startedAt.getTime())} ms` : ""}
              </p>
              {summaryText(r.summary) ? <p className="text-sm">{summaryText(r.summary)}</p> : null}
              {r.error ? <p className="break-words text-sm font-semibold text-danger">{r.error}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
