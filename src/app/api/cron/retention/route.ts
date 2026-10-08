import { getDb } from "@/db";
import { json } from "@/lib/api";
import { runJob } from "@/server/jobs";
import { retentionJob } from "@/server/jobs-retention";
import { authoriseCron } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Daily (vercel.json): anonymise bookings and customers past the retention period. */
export async function GET(req: Request): Promise<Response> {
  const denied = authoriseCron(req);
  if (denied) return denied;
  const db = await getDb();
  const run = await runJob(db, "retention", "cron", () => retentionJob(db));
  return json({ job: run.job, status: run.status, summary: run.summary, error: run.error }, { status: run.status === "ok" ? 200 : 500 });
}
