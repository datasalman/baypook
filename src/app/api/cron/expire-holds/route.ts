import { getDb } from "@/db";
import { json } from "@/lib/api";
import { expireHoldsJob, runJob } from "@/server/jobs";
import { authoriseCron } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const denied = authoriseCron(req);
  if (denied) return denied;
  const db = await getDb();
  const run = await runJob(db, "expire-holds", "cron", () => expireHoldsJob(db));
  return json({ job: run.job, status: run.status, summary: run.summary, error: run.error }, { status: run.status === "ok" ? 200 : 500 });
}
