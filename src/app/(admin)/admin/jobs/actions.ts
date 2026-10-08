"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { requireUser } from "@/server/auth";
import { audit } from "@/server/audit";
import { withFlash } from "@/components/ui/flash";
import { JOBS, isJobKey, runJobNow } from "./registry";

const BACK = "/admin/jobs";

/** "Run now": owners and managers only. */
export async function runJobAction(formData: FormData): Promise<void> {
  const user = await requireUser(BACK);
  if (!user.isOwner && !user.venues.some((v) => v.role === "manager")) {
    redirect(withFlash(BACK, "Only the owner and managers can run jobs.", "error"));
  }
  const key = formData.get("job");
  if (!isJobKey(key)) redirect(withFlash(BACK, "Unknown job.", "error"));
  const title = JOBS.find((j) => j.key === key)?.title ?? key;

  const db = await getDb();
  const run = await runJobNow(db, key, "admin");
  if (!run) redirect(withFlash(BACK, `${title} is not ready yet.`, "error"));
  await audit(db, { user, action: "job.run", entityType: "job_run", entityId: run.id, after: { job: key, status: run.status } });
  revalidatePath(BACK);
  redirect(
    run.status === "failed"
      ? withFlash(BACK, `${title} failed: ${run.error ?? "unknown error"}`, "error")
      : withFlash(BACK, `${title} ran`),
  );
}
