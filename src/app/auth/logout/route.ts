import { NextResponse, type NextRequest } from "next/server";
import { signOut } from "@/server/auth";
import { VENUE_COOKIE } from "@/server/venue-scope";

export const dynamic = "force-dynamic";

async function logout(req: NextRequest) {
  await signOut();
  const res = NextResponse.redirect(new URL("/login", req.nextUrl.origin), 303);
  res.cookies.delete(VENUE_COOKIE);
  return res;
}

/**
 * Sign-out: `<form action="/auth/logout" method="post">`. POST only, so a
 * prefetched or crawled link can never sign anyone out.
 */
export async function POST(req: NextRequest) {
  return logout(req);
}

/** GET shows the login page (which offers "Sign out" when signed in). */
export async function GET(req: NextRequest) {
  return NextResponse.redirect(new URL("/login", req.nextUrl.origin), 303);
}
