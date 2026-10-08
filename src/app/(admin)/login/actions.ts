"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import {
  SESSION_COOKIE,
  deleteSessionByToken,
  requestMagicLink,
  safeNextPath,
  setSessionCookie,
  signInAsDemoUser,
} from "@/server/auth";

export type MagicLinkState =
  | { status: "idle" }
  | { status: "sent"; email: string; link?: string }
  | { status: "error"; message: string };

/** Login form: email a sign-in link. Same answer whether or not the email has an account. */
export async function requestLinkAction(_prev: MagicLinkState, formData: FormData): Promise<MagicLinkState> {
  const email = String(formData.get("email") ?? "").trim();
  const next = safeNextPath(String(formData.get("next") ?? ""), "/admin");
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    return { status: "error", message: "Please enter the email address you use for work." };
  }
  try {
    const db = await getDb();
    const r = await requestMagicLink(db, email, { next });
    return { status: "sent", email, link: r.link };
  } catch (e) {
    console.error("[login] requestMagicLink failed", e);
    return { status: "error", message: "Something went wrong sending the link. Please try again in a minute." };
  }
}

/** Demo only: sign in as one of the seeded demo users. */
export async function demoSignInAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "");
  const next = safeNextPath(String(formData.get("next") ?? ""), "/admin");
  const db = await getDb();
  const jar = await cookies();
  // Switching user: drop the previous session row too.
  await deleteSessionByToken(db, jar.get(SESSION_COOKIE)?.value);
  const session = await signInAsDemoUser(db, email);
  await setSessionCookie(session);
  // A new person starts on their default venue.
  jar.delete("bp_venue");
  redirect(next);
}
