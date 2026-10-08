import { getDb } from "@/db";
import { json } from "@/lib/api";
import { runJob } from "@/server/jobs";
import { remindersJob } from "@/server/jobs-reminders";
import { authoriseCron } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Hourly (vercel.json): email a reminder before each confirmed booking, once. */
export async function GET(req: Request): Promise<Response> {
  const denied = authoriseCron(req);
  if (denied) return denied;
  const db = await getDb();
  const run = await runJob(db, "reminders", "cron", () => remindersJob(db));
  return json({ job: run.job, status: run.status, summary: run.summary, error: run.error }, { status: run.status === "ok" ? 200 : 500 });
}
