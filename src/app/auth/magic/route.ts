import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { consumeMagicLink, safeNextPath, setSessionCookie } from "@/server/auth";

export const dynamic = "force-dynamic";

/** `/auth/magic?token=…&next=…`: consume a sign-in link, set the session cookie, go to the admin. */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const next = safeNextPath(req.nextUrl.searchParams.get("next"), "/admin");
  const db = await getDb();
  const session = await consumeMagicLink(db, token);
  if (!session) {
    const url = new URL("/login", req.nextUrl.origin);
    url.searchParams.set("error", "expired");
    if (next !== "/admin") url.searchParams.set("next", next);
    return NextResponse.redirect(url, 303);
  }
  await setSessionCookie(session);
  return NextResponse.redirect(new URL(next, req.nextUrl.origin), 303);
}
