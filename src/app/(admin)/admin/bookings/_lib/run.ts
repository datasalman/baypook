/**
 * Runs one booking admin action for the signed-in user, then redirects with a
 * flash message: the work's own message on success, a plain-words error otherwise.
 */
import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { getDb, type Db } from "@/db";
import { requireUser, type CurrentUser } from "@/server/auth";
import { poundsToPence } from "@/server/catalogue-admin";
import { withFlash, type FlashKind } from "@/components/ui/flash";
import { bookingErrorMessage } from "./errors";

export type ActionResult = string | { message: string; to?: string; kind?: FlashKind };

export async function runBookingAction(
  back: string,
  work: (ctx: { db: Db; user: CurrentUser }) => Promise<ActionResult>,
): Promise<never> {
  const user = await requireUser(back);
  const db = await getDb();
  let message: string;
  let to = back;
  let kind: FlashKind = "success";
  try {
    const r = await work({ db, user });
    if (typeof r === "string") message = r;
    else {
      message = r.message;
      to = r.to ?? back;
      kind = r.kind ?? "success";
    }
  } catch (e) {
    unstable_rethrow(e);
    message = bookingErrorMessage(e);
    kind = "error";
  }
  revalidatePath("/admin", "layout");
  redirect(withFlash(to, message, kind));
}

export function field(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/** Pounds ("17.50", "£17") to pence; NaN when it is not an amount. */
export function amountField(fd: FormData, key: string): number {
  return poundsToPence(field(fd, key));
}

/** A safe admin path from a hidden `back` field. */
export function backField(fd: FormData, fallback: string): string {
  const v = field(fd, "back");
  if (!v || !v.startsWith("/admin/") || v.startsWith("//") || v.includes("\\")) return fallback;
  return v;
}

/** `line:<optionId>` and `addon:<addOnId>` number fields from a quantities editor. */
export function quantitiesFromForm(fd: FormData): { lines: { optionId: string; qty: number }[]; addOns: { addOnId: string; qty: number }[] } {
  const lines: { optionId: string; qty: number }[] = [];
  const addOns: { addOnId: string; qty: number }[] = [];
  for (const [key, raw] of fd.entries()) {
    if (typeof raw !== "string") continue;
    const qty = Number(raw);
    if (!Number.isInteger(qty) || qty < 0) continue;
    if (key.startsWith("line:")) {
      if (qty > 0) lines.push({ optionId: key.slice(5), qty });
    } else if (key.startsWith("addon:")) {
      if (qty > 0) addOns.push({ addOnId: key.slice(6), qty });
    }
  }
  return { lines, addOns };
}
