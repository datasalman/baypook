"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as s from "@/db/schema";
import { canAccessVenue, requireUser } from "@/server/auth";
import { audit } from "@/server/audit";
import { syncBookingToCalendar } from "@/server/calendar";
import { withFlash } from "@/components/ui/flash";

const BACK = "/admin/calendar-log";

/** Push a failed calendar change again, with the same action. */
export async function retryCalendar(formData: FormData): Promise<void> {
  const user = await requireUser(BACK);
  const id = String(formData.get("id") ?? "");
  const db = await getDb();
  const [row] = /^[0-9a-f-]{36}$/i.test(id) ? await db.select().from(s.calendarLog).where(eq(s.calendarLog.id, id)).limit(1) : [];
  if (!row || !row.bookingId) redirect(withFlash(BACK, "That calendar entry was not found.", "error"));
  const allowed = row.venueId ? canAccessVenue(user, row.venueId) : user.isOwner;
  if (!allowed) redirect(withFlash(BACK, "You do not have access to that venue.", "error"));
  if (row.status !== "failed") redirect(withFlash(BACK, "That one did not fail.", "error"));

  const result = await syncBookingToCalendar(db, row.bookingId, row.action);
  await audit(db, {
    user,
    action: "calendar.retry",
    entityType: "booking",
    entityId: row.bookingId,
    venueId: row.venueId,
    after: { calendarLogId: result?.id ?? null, action: row.action, status: result?.status ?? "failed" },
  });
  revalidatePath(BACK);

  if (!result) redirect(withFlash(BACK, "The booking no longer exists.", "error"));
  if (result.status === "failed") redirect(withFlash(BACK, `Still failing: ${result.error ?? "unknown error"}`, "error"));
  redirect(withFlash(BACK, result.status === "demo" ? "Done (demo: written to the log only)" : "Done: the calendar is up to date"));
}
