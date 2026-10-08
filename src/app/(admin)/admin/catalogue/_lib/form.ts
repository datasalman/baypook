/**
 * FormData helpers shared by the catalogue and settings server actions, and the
 * one place that runs an admin write and redirects back with a flash message.
 */
import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { getDb, type Db } from "@/db";
import { requireUser, type CurrentUser } from "@/server/auth";
import { adminErrorMessage, poundsToPence } from "@/server/catalogue-admin";
import { withFlash, type FlashKind } from "@/components/ui/flash";
import type { FormActionState } from "@/components/ui/form-state";

export function str(fd: FormData, key: string): string | undefined {
  const v = fd.get(key);
  return typeof v === "string" ? v : undefined;
}

/** A number from a field; "" or missing is NaN (so validation says "enter a number"). */
export function num(fd: FormData, key: string): number {
  const v = str(fd, key)?.trim();
  return v ? Number(v) : Number.NaN;
}

/** A number, or null when the field is empty. */
export function optNum(fd: FormData, key: string): number | null {
  const v = str(fd, key)?.trim();
  return v ? Number(v) : null;
}

/** A checkbox: present ("on") is true, missing is false. */
export function bool(fd: FormData, key: string): boolean {
  const v = str(fd, key);
  return v === "on" || v === "true" || v === "1";
}

/** Pounds field ("17.50") to pence; NaN when not a price. */
export function pence(fd: FormData, key: string): number {
  return poundsToPence(str(fd, key));
}

/** Hours field (decimal allowed) to whole minutes. */
export function hoursToMinutes(fd: FormData, key: string): number {
  const v = num(fd, key);
  return Number.isFinite(v) ? Math.round(v * 60) : Number.NaN;
}

/** A safe admin path from a hidden `back` field. */
export function backPath(fd: FormData, fallback: string): string {
  const v = str(fd, "back");
  if (!v || !v.startsWith("/admin") || v.startsWith("//") || v.includes("\\")) return fallback;
  return v;
}

/**
 * Run an admin write for the signed-in user, then redirect to `back` with a
 * flash message: the work's own message on success, a plain-words error otherwise.
 * `work` may return `{ message, to }` to land somewhere else on success.
 */
export async function runAdminAction(
  back: string,
  work: (ctx: { db: Db; user: CurrentUser }) => Promise<string | { message: string; to: string }>,
): Promise<never> {
  const user = await requireUser();
  const db = await getDb();
  let message: string;
  let to = back;
  let kind: FlashKind = "success";
  try {
    const r = await work({ db, user });
    if (typeof r === "string") message = r;
    else {
      message = r.message;
      to = r.to;
    }
  } catch (e) {
    unstable_rethrow(e);
    message = adminErrorMessage(e);
    kind = "error";
  }
  revalidatePath("/admin", "layout");
  redirect(withFlash(to, message, kind));
}

/**
 * Like `runAdminAction`, for forms rendered with `<ActionForm>`: on success it
 * redirects with a flash; on error it returns `{ error }` so the form stays as
 * typed (and any open panel stays open) instead of reloading the page.
 */
export async function runAdminFormAction(
  back: string,
  work: (ctx: { db: Db; user: CurrentUser }) => Promise<string | { message: string; to: string }>,
): Promise<FormActionState> {
  const user = await requireUser();
  const db = await getDb();
  let message: string;
  let to = back;
  try {
    const r = await work({ db, user });
    if (typeof r === "string") message = r;
    else {
      message = r.message;
      to = r.to;
    }
  } catch (e) {
    unstable_rethrow(e);
    return { error: adminErrorMessage(e) };
  }
  revalidatePath("/admin", "layout");
  redirect(withFlash(to, message));
}
