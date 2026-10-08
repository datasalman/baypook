"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { requireUser, type VenueRole } from "@/server/auth";
import { inviteUser, resendInvite, setUserActive, updateUser, UsersAdminError, type VenueRoleInput } from "@/server/users-admin";
import { withFlash } from "@/components/ui/flash";
import { isDemo } from "@/lib/env";

const BACK = "/admin/users";

/** `values` comes back on an error so the form can put back what was typed (React clears it otherwise). */
export type InviteState = {
  ok: boolean;
  message: string;
  link?: string;
  email?: string;
  values?: { email: string; name: string; role: string; venueId: string };
} | null;

function message(e: unknown): string {
  if (e instanceof UsersAdminError) return e.message;
  console.error("[users] action failed", e);
  return "Something went wrong. Please try again.";
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/** Invite form (useActionState): returns the result so the page can show the demo link. */
export async function inviteAction(_prev: InviteState, formData: FormData): Promise<InviteState> {
  const by = await requireUser(BACK);
  const role = str(formData, "role");
  const venueId = str(formData, "venueId");
  const values = { email: str(formData, "email").slice(0, 200), name: str(formData, "name").slice(0, 120), role, venueId };
  if (role !== "owner" && role !== "manager" && role !== "staff") return { ok: false, message: "Choose a role.", values };
  const isOwner = role === "owner";
  const venues: VenueRoleInput[] = !isOwner && venueId ? [{ venueId, role }] : [];
  if (!isOwner && !venues.length) return { ok: false, message: "Choose the venue they work at.", values };
  try {
    const db = await getDb();
    const r = await inviteUser(db, { by, email: values.email, name: values.name, isOwner, venues });
    revalidatePath(BACK);
    return {
      ok: true,
      email: r.user.email,
      message: isDemo()
        ? `${r.user.name} can sign in now. Demo mode: no email was sent; use the link below or find it in the Outbox.`
        : `Invite sent to ${r.user.email}. The link works once and lasts 15 minutes; send a new one from their row if it runs out.`,
      link: r.link,
    };
  } catch (e) {
    return { ok: false, message: message(e), values };
  }
}

/** Edit name, owner flag and per-venue roles (`role_<venueId>` = "" | manager | staff). */
export async function updateUserAction(formData: FormData): Promise<void> {
  const by = await requireUser(BACK);
  const userId = str(formData, "userId");
  const isOwner = formData.get("isOwner") === "on";
  const venues: VenueRoleInput[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("role_")) continue;
    const role = String(value);
    if (role === "manager" || role === "staff") venues.push({ venueId: key.slice("role_".length), role: role as VenueRole });
  }
  let flash: string;
  try {
    const db = await getDb();
    await updateUser(db, { by, userId, name: str(formData, "name"), isOwner, venues });
    revalidatePath(BACK);
    flash = withFlash(BACK, "Saved");
  } catch (e) {
    flash = withFlash(BACK, message(e), "error");
  }
  redirect(flash);
}

export async function setActiveAction(formData: FormData): Promise<void> {
  const by = await requireUser(BACK);
  const userId = str(formData, "userId");
  const active = str(formData, "active") === "1";
  let flash: string;
  try {
    const db = await getDb();
    await setUserActive(db, { by, userId, active });
    revalidatePath(BACK);
    flash = withFlash(BACK, active ? "Login turned back on" : "Login turned off. They have been signed out.");
  } catch (e) {
    flash = withFlash(BACK, message(e), "error");
  }
  redirect(flash);
}

export async function sendLinkAction(formData: FormData): Promise<void> {
  const by = await requireUser(BACK);
  let flash: string;
  try {
    const db = await getDb();
    await resendInvite(db, { by, userId: str(formData, "userId") });
    flash = withFlash(BACK, isDemo() ? "New sign-in link written to the Outbox (demo: not sent)" : "New sign-in link sent");
  } catch (e) {
    flash = withFlash(BACK, message(e), "error");
  }
  redirect(flash);
}
