/**
 * Admin authentication: magic link by email, single-use 15-minute token,
 * httpOnly session cookie (`<sessionId>.<token>`; only sha256(token) is stored).
 *
 * The request-scoped helpers (`getCurrentUser`, `requireUser`, `signOut`,
 * `setSessionCookie`) read `cookies()`; everything else takes the db and tokens
 * explicitly so it can be tested without a request.
 */
import crypto from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@/db";
import * as s from "@/db/schema";
import { env, isDemo } from "@/lib/env";

export const SESSION_COOKIE = "bp_session";

export const MAGIC_LINK_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const LAST_SEEN_BUMP_MS = 10 * 60_000;
/** At most this many unused, unexpired links per user at once (slows down mail-bombing). */
const MAX_LIVE_LINKS = 5;

export type VenueRole = "manager" | "staff";
export type Role = "owner" | VenueRole;

export type CurrentUser = {
  id: string;
  email: string;
  name: string;
  isOwner: boolean;
  venues: { venueId: string; role: VenueRole }[];
};

export type AuthErrorCode = "UNAUTHENTICATED" | "FORBIDDEN";

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode, message?: string) {
    super(message ?? (code === "FORBIDDEN" ? "You do not have access to this." : "Please sign in."));
    this.name = "AuthError";
    this.code = code;
  }
}

/** The three seeded demo users offered on the demo login page. */
export const DEMO_USERS = [
  { email: "owner@demo.baypook", label: "Sign in as owner" },
  { email: "manager.southwoodford@demo.baypook", label: "Sign in as South Woodford manager" },
  { email: "staff.lakeside@demo.baypook", label: "Sign in as Lakeside staff" },
] as const;

// ---------- hashing ----------

function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Magic-link hash is keyed with APP_SECRET so a leaked DB row alone cannot forge a link. */
export function magicTokenHash(token: string): string {
  return crypto.createHmac("sha256", env.appSecret()).update(token).digest("hex");
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Only allow same-site relative paths as post-login destinations. */
export function safeNextPath(next: string | null | undefined, fallback = "/admin"): string {
  if (!next || typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (next.startsWith("/login") || next.startsWith("/auth/")) return fallback;
  return next;
}

// ---------- roles (pure) ----------

export function isOwner(u: CurrentUser): boolean {
  return u.isOwner;
}

export function roleAt(u: CurrentUser, venueId: string): Role | null {
  if (u.isOwner) return "owner";
  return u.venues.find((v) => v.venueId === venueId)?.role ?? null;
}

export function canAccessVenue(u: CurrentUser, venueId: string): boolean {
  return roleAt(u, venueId) !== null;
}

export function canRefund(u: CurrentUser, venueId: string): boolean {
  const r = roleAt(u, venueId);
  return r === "owner" || r === "manager";
}

export function canManageCatalogue(u: CurrentUser, venueId: string): boolean {
  const r = roleAt(u, venueId);
  return r === "owner" || r === "manager";
}

export function visibleVenueIds(u: CurrentUser, allVenueIds: string[]): string[] {
  if (u.isOwner) return [...allVenueIds];
  return allVenueIds.filter((id) => u.venues.some((v) => v.venueId === id));
}

export async function requireVenueAccess(u: CurrentUser, venueId: string): Promise<void> {
  if (!canAccessVenue(u, venueId)) throw new AuthError("FORBIDDEN");
}

/** Throws FORBIDDEN unless the user is the owner. */
export function requireOwner(u: CurrentUser): void {
  if (!u.isOwner) throw new AuthError("FORBIDDEN");
}

// ---------- users & sessions (db, testable) ----------

export async function loadUser(db: DbOrTx, userId: string): Promise<CurrentUser | null> {
  const [u] = await db.select().from(s.users).where(eq(s.users.id, userId)).limit(1);
  if (!u || !u.active) return null;
  const rows = await db.select().from(s.userVenues).where(eq(s.userVenues.userId, u.id));
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    isOwner: u.isOwner,
    venues: rows.map((r) => ({ venueId: r.venueId, role: r.role })),
  };
}

/** Create a session row and return the cookie value. */
export async function createSession(db: DbOrTx, userId: string): Promise<{ sessionToken: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const now = new Date();
  const [row] = await db
    .insert(s.sessionsAuth)
    .values({ userId, tokenHash: sha256(token), expiresAt, lastSeenAt: now })
    .returning({ id: s.sessionsAuth.id });
  await db.update(s.users).set({ lastLoginAt: now, updatedAt: now }).where(eq(s.users.id, userId));
  return { sessionToken: `${row.id}.${token}`, expiresAt };
}

function parseSessionToken(value: string): { id: string; token: string } | null {
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const id = value.slice(0, dot);
  const token = value.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/i.test(id) || token.length < 20) return null;
  return { id, token };
}

/** Validate a session cookie value and return its user. Bumps lastSeenAt at most every 10 minutes. */
export async function getUserBySessionToken(db: DbOrTx, cookieValue: string | null | undefined): Promise<CurrentUser | null> {
  if (!cookieValue) return null;
  const parsed = parseSessionToken(cookieValue);
  if (!parsed) return null;
  const [row] = await db.select().from(s.sessionsAuth).where(eq(s.sessionsAuth.id, parsed.id)).limit(1);
  if (!row) return null;
  const expected = Buffer.from(row.tokenHash, "hex");
  const given = Buffer.from(sha256(parsed.token), "hex");
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  const now = Date.now();
  if (row.expiresAt.getTime() <= now) return null;
  const user = await loadUser(db, row.userId);
  if (!user) return null;
  if (!row.lastSeenAt || now - row.lastSeenAt.getTime() > LAST_SEEN_BUMP_MS) {
    await db.update(s.sessionsAuth).set({ lastSeenAt: new Date(now) }).where(eq(s.sessionsAuth.id, row.id));
  }
  return user;
}

/** Delete the session row behind a cookie value (sign out). */
export async function deleteSessionByToken(db: DbOrTx, cookieValue: string | null | undefined): Promise<void> {
  if (!cookieValue) return;
  const parsed = parseSessionToken(cookieValue);
  if (!parsed) return;
  await db
    .delete(s.sessionsAuth)
    .where(and(eq(s.sessionsAuth.id, parsed.id), eq(s.sessionsAuth.tokenHash, sha256(parsed.token))));
}

// ---------- magic links ----------

export function magicLinkUrl(token: string, next?: string): string {
  const base = env.baseUrl().replace(/\/+$/, "");
  const q = new URLSearchParams({ token });
  const safe = next ? safeNextPath(next, "") : "";
  if (safe) q.set("next", safe);
  return `${base}/auth/magic?${q.toString()}`;
}

/**
 * Create and email a sign-in link. Unknown or inactive emails get the same
 * `{ sent: true }` answer and nothing is created (no account enumeration).
 * In demo mode the link is returned as well so the login page can show it.
 */
export async function requestMagicLink(db: Db, email: string, opts: { next?: string } = {}): Promise<{ sent: boolean; link?: string }> {
  const addr = normaliseEmail(email);
  if (!addr || !addr.includes("@")) return { sent: true };
  const [user] = await db.select().from(s.users).where(eq(s.users.email, addr)).limit(1);
  if (!user || !user.active) return { sent: true };

  const now = new Date();
  const [{ live }] = await db
    .select({ live: sql<number>`count(*)` })
    .from(s.magicLinks)
    .where(and(eq(s.magicLinks.userId, user.id), isNull(s.magicLinks.usedAt), gt(s.magicLinks.expiresAt, now)));
  if (Number(live) >= MAX_LIVE_LINKS) return { sent: true };

  const token = randomToken();
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL_MS);
  await db.insert(s.magicLinks).values({ userId: user.id, tokenHash: magicTokenHash(token), expiresAt });
  const link = magicLinkUrl(token, opts.next);

  const [org] = await db.select({ name: s.organisations.name }).from(s.organisations).limit(1);
  const appName = org?.name ? `${org.name} admin` : "BayPook admin";
  const subject = `Your sign-in link for ${appName}`;
  const text = [
    `Hello ${user.name || ""}`.trim() + ",",
    "",
    `Use this link to sign in to ${appName}. It works once and lasts 15 minutes.`,
    "",
    link,
    "",
    "If you did not ask for it, you can ignore this email.",
  ].join("\n");
  const html = `<p>Hello${user.name ? ` ${escapeHtml(user.name)}` : ""},</p>
<p>Use this link to sign in to ${escapeHtml(appName)}. It works once and lasts 15 minutes.</p>
<p><a href="${escapeHtml(link)}">Sign in</a></p>
<p style="word-break:break-all;color:#555">${escapeHtml(link)}</p>
<p>If you did not ask for it, you can ignore this email.</p>`;

  await sendMagicLinkEmail(db, { to: user.email, subject, html, text });
  return isDemo() ? { sent: true, link } : { sent: true };
}

async function sendMagicLinkEmail(db: Db, msg: { to: string; subject: string; html: string; text: string }): Promise<void> {
  try {
    const { sendRawEmail } = await import("@/server/notifications");
    await sendRawEmail(db, { ...msg, template: "magic_link", venueId: null });
  } catch (err) {
    // Fallback if the notifications service is unavailable: write the Outbox row
    // and hand the message to the email provider directly. Never throws.
    console.error("[auth] sendRawEmail failed, using fallback", err);
    await fallbackSend(db, msg);
  }
}

async function fallbackSend(db: Db, msg: { to: string; subject: string; html: string; text: string }): Promise<void> {
  try {
    const { getEmailProvider } = await import("@/providers");
    const { provider } = await getEmailProvider();
    const [row] = await db
      .insert(s.notifications)
      .values({ template: "magic_link", toAddress: msg.to, subject: msg.subject, status: "queued", bodyHtml: msg.html, bodyText: msg.text })
      .returning({ id: s.notifications.id });
    try {
      const r = await provider.send(msg);
      await db
        .update(s.notifications)
        .set({ status: r.status, providerId: r.providerId, sentAt: new Date() })
        .where(eq(s.notifications.id, row.id));
    } catch (e) {
      await db
        .update(s.notifications)
        .set({ status: "failed", error: e instanceof Error ? e.message : String(e) })
        .where(eq(s.notifications.id, row.id));
    }
  } catch (e) {
    console.error("[auth] could not record magic link email", e);
  }
}

/** Consume a magic link once. Returns a new session, or null if unknown, used or expired. */
export async function consumeMagicLink(db: Db, token: string): Promise<{ sessionToken: string; expiresAt: Date } | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const now = new Date();
  // Atomic single use: only one caller can flip usedAt from null.
  const [link] = await db
    .update(s.magicLinks)
    .set({ usedAt: now })
    .where(and(eq(s.magicLinks.tokenHash, magicTokenHash(token)), isNull(s.magicLinks.usedAt), gt(s.magicLinks.expiresAt, now)))
    .returning();
  if (!link) return null;
  const user = await loadUser(db, link.userId);
  if (!user) return null;
  return createSession(db, user.id);
}

/** Demo only: sign in as one of the seeded demo users without email. */
export async function signInAsDemoUser(db: Db, email: string): Promise<{ sessionToken: string; expiresAt: Date }> {
  if (!isDemo()) throw new AuthError("FORBIDDEN", "Demo sign-in is only available in demo mode.");
  const addr = normaliseEmail(email);
  if (!DEMO_USERS.some((d) => d.email === addr)) throw new AuthError("FORBIDDEN", "Not a demo user.");
  const [user] = await db.select().from(s.users).where(eq(s.users.email, addr)).limit(1);
  if (!user || !user.active) throw new AuthError("FORBIDDEN", "Demo user not found. Try npm run demo:reset.");
  return createSession(db, user.id);
}

// ---------- request-scoped helpers ----------

function cookieSecure(): boolean {
  return env.baseUrl().startsWith("https://");
}

/** Set the session cookie (route handlers and server actions only). */
export async function setSessionCookie(session: { sessionToken: string; expiresAt: Date }): Promise<void> {
  const { cookies } = await import("next/headers");
  const jar = await cookies();
  jar.set(SESSION_COOKIE, session.sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: "/",
    expires: session.expiresAt,
  });
}

async function readSessionCookie(): Promise<string | undefined> {
  const { cookies } = await import("next/headers");
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value;
}

async function getCurrentUserUncached(): Promise<CurrentUser | null> {
  const value = await readSessionCookie();
  if (!value) return null;
  const { getDb } = await import("@/db");
  const db = await getDb();
  return getUserBySessionToken(db, value);
}

let cachedGetCurrentUser: (() => Promise<CurrentUser | null>) | null = null;

/** The signed-in user for this request, or null. Deduplicated per request. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  if (!cachedGetCurrentUser) {
    const { cache } = await import("react");
    cachedGetCurrentUser = cache(getCurrentUserUncached);
  }
  return cachedGetCurrentUser();
}

/**
 * The signed-in user, or a redirect to /login. Pass the current path (with
 * query) as `nextPath` so the user comes back to it after signing in.
 */
export async function requireUser(nextPath?: string): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (user) return user;
  const { redirect } = await import("next/navigation");
  const next = safeNextPath(nextPath ?? (await guessCurrentPath()), "/admin");
  return redirect(`/login?next=${encodeURIComponent(next)}`);
}

async function guessCurrentPath(): Promise<string | undefined> {
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    return h.get("x-pathname") ?? h.get("next-url") ?? undefined;
  } catch {
    return undefined;
  }
}

/** Clear the session cookie and delete its row (route handlers and server actions only). */
export async function signOut(): Promise<void> {
  const value = await readSessionCookie();
  if (value) {
    const { getDb } = await import("@/db");
    const db = await getDb();
    await deleteSessionByToken(db, value);
  }
  const { cookies } = await import("next/headers");
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
