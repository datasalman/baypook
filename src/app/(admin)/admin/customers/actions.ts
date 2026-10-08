"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { getDb } from "@/db";
import { requireUser } from "@/server/auth";
import { isUuid } from "@/server/catalogue";
import { withFlash, type FlashKind } from "@/components/ui/flash";
import { CustomerAdminError, updateCustomerNotes } from "./_lib/customers";

export async function saveCustomerNotesAction(fd: FormData): Promise<void> {
  const raw = fd.get("customerId");
  const id = typeof raw === "string" && isUuid(raw) ? raw : "";
  const back = id ? `/admin/customers/${id}` : "/admin/customers";
  const user = await requireUser(back);
  const db = await getDb();
  const notes = fd.get("notes");
  let message = "Notes saved";
  let kind: FlashKind = "success";
  try {
    await updateCustomerNotes(db, { customerId: id, user, notes: typeof notes === "string" ? notes : "" });
  } catch (e) {
    unstable_rethrow(e);
    kind = "error";
    if (e instanceof CustomerAdminError) message = e.message;
    else {
      console.error("[admin customers] unexpected error", e);
      message = "Something went wrong. Please try again.";
    }
  }
  revalidatePath(back);
  redirect(withFlash(back, message, kind));
}
