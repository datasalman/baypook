"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as s from "@/db/schema";
import { canAccessVenue, requireUser } from "@/server/auth";
import { audit } from "@/server/audit";
import { sendBookingEmail, sendRawEmail, type TemplateKey } from "@/server/notifications";
import { withFlash } from "@/components/ui/flash";

const BOOKING_TEMPLATES: readonly string[] = ["confirmation", "reminder", "cancellation", "refund", "owner_new_party"] satisfies TemplateKey[];

function isBookingTemplate(t: string): t is TemplateKey {
  return BOOKING_TEMPLATES.includes(t);
}

function backPath(formData: FormData): string {
  const back = String(formData.get("back") ?? "");
  return back.startsWith("/admin/outbox") && !back.startsWith("//") ? back : "/admin/outbox";
}

/** Send a failed or demo email again: re-rendered from the booking when there is one, else the stored copy. */
export async function resendEmail(formData: FormData): Promise<void> {
  const user = await requireUser("/admin/outbox");
  const back = backPath(formData);
  const id = String(formData.get("id") ?? "");
  const db = await getDb();
  const [row] = /^[0-9a-f-]{36}$/i.test(id) ? await db.select().from(s.notifications).where(eq(s.notifications.id, id)).limit(1) : [];
  if (!row) redirect(withFlash(back, "That email was not found.", "error"));
  const allowed = row.venueId ? canAccessVenue(user, row.venueId) : user.isOwner;
  if (!allowed) redirect(withFlash(back, "You do not have access to that email.", "error"));
  if (row.status !== "failed" && row.status !== "demo") redirect(withFlash(back, "That email was already sent.", "error"));
  if (row.template === "magic_link") {
    redirect(withFlash(back, "Sign-in links cannot be sent again. Ask for a new one on the sign-in page.", "error"));
  }

  const sent =
    row.bookingId && isBookingTemplate(row.template)
      ? await sendBookingEmail(db, { bookingId: row.bookingId, template: row.template, to: row.toAddress })
      : await sendRawEmail(db, {
          to: row.toAddress,
          subject: row.subject,
          html: row.bodyHtml,
          text: row.bodyText,
          template: row.template,
          venueId: row.venueId,
          attachments: row.attachments,
        });

  await audit(db, {
    user,
    action: "email.resend",
    entityType: "notification",
    entityId: row.id,
    venueId: row.venueId,
    after: { newNotificationId: sent.id, status: sent.status, to: sent.toAddress, template: sent.template },
  });
  revalidatePath("/admin/outbox");

  if (sent.status === "sent") redirect(withFlash(back, `Sent again to ${sent.toAddress}`));
  if (sent.status === "failed") redirect(withFlash(back, `Could not send: ${sent.error ?? "unknown error"}`, "error"));
  if (sent.error) redirect(withFlash(back, sent.error, "error"));
  redirect(withFlash(back, "Written to the Outbox again (demo: not sent)"));
}
