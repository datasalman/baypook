/**
 * Shared by every `/api/cron/*` route. Vercel Cron sends
 * `Authorization: Bearer <CRON_SECRET>`; demo mode is always allowed so the
 * jobs can be run by hand.
 */
import crypto from "node:crypto";
import { env, isDemo } from "@/lib/env";
import { json } from "@/lib/api";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** null when the request may run the job; otherwise the 401 response to return. */
export function authoriseCron(req: Request): Response | null {
  if (isDemo()) return null;
  const secret = env.cronSecret();
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (secret && token && safeEqual(token, secret)) return null;
  return json({ error: { code: "UNAUTHORISED", message: "Missing or wrong CRON_SECRET." } }, { status: 401 });
}
