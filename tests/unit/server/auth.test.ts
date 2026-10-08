process.env.BAYPOOK_MODE = "demo";

import { beforeAll, describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import { createTestDb, type Db } from "@/db";
import * as s from "@/db/schema";
import {
  canAccessVenue,
  canManageCatalogue,
  canRefund,
  consumeMagicLink,
  getUserBySessionToken,
  loadUser,
  magicTokenHash,
  requestMagicLink,
  requireVenueAccess,
  SESSION_IDLE_TIMEOUT_MS,
  roleAt,
  safeNextPath,
  sha256,
  signInAsDemoUser,
  visibleVenueIds,
  type CurrentUser,
} from "@/server/auth";
import { resolveSelectedVenue } from "@/server/venue-scope";
import { audit, listAudit } from "@/server/audit";

let db: Db;
let sw: string;
let lk: string;
let owner: CurrentUser;
let manager: CurrentUser;
let staff: CurrentUser;

async function userByEmail(email: string): Promise<CurrentUser> {
  const [u] = await db.select().from(s.users).where(eq(s.users.email, email));
  const loaded = await loadUser(db, u.id);
  if (!loaded) throw new Error(`no user ${email}`);
  return loaded;
}

function tokenFrom(link: string): string {
  return new URL(link).searchParams.get("token") ?? "";
}

beforeAll(async () => {
  db = await createTestDb({ seed: true });
  const venues = await db.select().from(s.venues);
  sw = venues.find((v) => v.slug === "south-woodford")!.id;
  lk = venues.find((v) => v.slug === "lakeside")!.id;
  owner = await userByEmail("owner@demo.baypook");
  manager = await userByEmail("manager.southwoodford@demo.baypook");
  staff = await userByEmail("staff.lakeside@demo.baypook");
});

describe("magic links", () => {
  it("returns a link in demo mode, consumes once, and refuses a second use", async () => {
    const r = await requestMagicLink(db, "  Owner@Demo.Baypook ");
    expect(r.sent).toBe(true);
    expect(r.link).toMatch(/\/auth\/magic\?token=/);
    const token = tokenFrom(r.link!);

    // Only an HMAC of the token is stored, never the token itself.
    const rows = await db.select().from(s.magicLinks);
    expect(rows.some((row) => row.tokenHash === token)).toBe(false);
    expect(rows.some((row) => row.tokenHash === magicTokenHash(token))).toBe(true);

    // The email lands in the Outbox.
    const outbox = await db.select().from(s.notifications).where(eq(s.notifications.template, "magic_link"));
    expect(outbox.length).toBeGreaterThan(0);
    expect(outbox[0].toAddress).toBe("owner@demo.baypook");

    const first = await consumeMagicLink(db, token);
    expect(first).not.toBeNull();
    expect(first!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600_000);
    const user = await getUserBySessionToken(db, first!.sessionToken);
    expect(user?.email).toBe("owner@demo.baypook");
    expect(user?.isOwner).toBe(true);

    const [sessionRow] = await db.select().from(s.sessionsAuth).where(eq(s.sessionsAuth.id, first!.sessionToken.split(".")[0]));
    expect(sessionRow.tokenHash).toBe(sha256(first!.sessionToken.split(".")[1]));

    const [u] = await db.select().from(s.users).where(eq(s.users.email, "owner@demo.baypook"));
    expect(u.lastLoginAt).not.toBeNull();

    expect(await consumeMagicLink(db, token)).toBeNull();
  });

  it("refuses an expired link", async () => {
    const r = await requestMagicLink(db, "staff.lakeside@demo.baypook");
    const token = tokenFrom(r.link!);
    await db.update(s.magicLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(s.magicLinks.tokenHash, magicTokenHash(token)));
    expect(await consumeMagicLink(db, token)).toBeNull();
  });

  it("answers an unknown email the same way without a link and creates nothing", async () => {
    const [{ before }] = await db.select({ before: count() }).from(s.magicLinks);
    const [{ mailsBefore }] = await db.select({ mailsBefore: count() }).from(s.notifications);
    const r = await requestMagicLink(db, "nobody@example.com");
    expect(r).toEqual({ sent: true });
    const [{ after }] = await db.select({ after: count() }).from(s.magicLinks);
    const [{ mailsAfter }] = await db.select({ mailsAfter: count() }).from(s.notifications);
    expect(Number(after)).toBe(Number(before));
    expect(Number(mailsAfter)).toBe(Number(mailsBefore));
  });

  it("rejects garbage tokens and session cookies", async () => {
    expect(await consumeMagicLink(db, "")).toBeNull();
    expect(await consumeMagicLink(db, "x".repeat(43))).toBeNull();
    expect(await getUserBySessionToken(db, "nonsense")).toBeNull();
    const demo = await signInAsDemoUser(db, "manager.southwoodford@demo.baypook");
    const [id] = demo.sessionToken.split(".");
    expect(await getUserBySessionToken(db, `${id}.${"y".repeat(43)}`)).toBeNull();
    expect((await getUserBySessionToken(db, demo.sessionToken))?.email).toBe("manager.southwoodford@demo.baypook");
  });

  it("rejects and deletes a session idle for more than 14 days", async () => {
    const demo = await signInAsDemoUser(db, "staff.lakeside@demo.baypook");
    const [id] = demo.sessionToken.split(".");
    const start = Date.now();
    const day = 24 * 3600_000;

    // Used after 13 days: still valid, and lastSeenAt moves on.
    const later = new Date(start + 13 * day);
    expect((await getUserBySessionToken(db, demo.sessionToken, later))?.email).toBe("staff.lakeside@demo.baypook");
    const [row] = await db.select().from(s.sessionsAuth).where(eq(s.sessionsAuth.id, id));
    expect(row.lastSeenAt?.getTime()).toBe(later.getTime());

    // 26 days after sign-in but only 13 idle: still valid.
    expect(await getUserBySessionToken(db, demo.sessionToken, new Date(later.getTime() + 13 * day))).not.toBeNull();

    // A session left alone for more than 14 days: refused and the row is gone, though its 30 days are not up.
    const fresh = await signInAsDemoUser(db, "staff.lakeside@demo.baypook");
    const [freshId] = fresh.sessionToken.split(".");
    await db.update(s.sessionsAuth).set({ lastSeenAt: new Date(start + 2 * day) }).where(eq(s.sessionsAuth.id, freshId));
    const check = new Date(start + 2 * day + SESSION_IDLE_TIMEOUT_MS + 1000);
    expect(await getUserBySessionToken(db, fresh.sessionToken, check)).toBeNull();
    expect(await db.select().from(s.sessionsAuth).where(eq(s.sessionsAuth.id, freshId))).toHaveLength(0);
  });

  it("takes as long for an unknown email as for a known one", async () => {
    const t0 = performance.now();
    expect(await requestMagicLink(db, "nobody@example.com", { minResponseMs: 120 })).toEqual({ sent: true });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(115);
    const t1 = performance.now();
    expect((await requestMagicLink(db, "owner@demo.baypook", { minResponseMs: 120 })).sent).toBe(true);
    expect(performance.now() - t1).toBeGreaterThanOrEqual(115);
  });

  it("signs in demo users only", async () => {
    await expect(signInAsDemoUser(db, "someone@example.com")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("roles and venue scoping", () => {
  it("canRefund matrix for the three seeded users", () => {
    expect([canRefund(owner, sw), canRefund(owner, lk)]).toEqual([true, true]);
    expect([canRefund(manager, sw), canRefund(manager, lk)]).toEqual([true, false]);
    expect([canRefund(staff, sw), canRefund(staff, lk)]).toEqual([false, false]);
    expect([canManageCatalogue(manager, sw), canManageCatalogue(staff, lk)]).toEqual([true, false]);
  });

  it("roles and visible venues", async () => {
    expect(roleAt(owner, sw)).toBe("owner");
    expect(roleAt(manager, sw)).toBe("manager");
    expect(roleAt(staff, lk)).toBe("staff");
    expect(roleAt(staff, sw)).toBeNull();
    expect(visibleVenueIds(owner, [sw, lk])).toEqual([sw, lk]);
    expect(visibleVenueIds(manager, [sw, lk])).toEqual([sw]);
    expect(visibleVenueIds(staff, [sw, lk])).toEqual([lk]);
    expect(canAccessVenue(staff, sw)).toBe(false);
    await expect(requireVenueAccess(staff, sw)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(requireVenueAccess(staff, lk)).resolves.toBeUndefined();
  });

  it("resolves the selected venue from the cookie", () => {
    const both = [{ id: sw }, { id: lk }];
    expect(resolveSelectedVenue(owner, both, undefined)).toBe("all");
    expect(resolveSelectedVenue(owner, both, lk)).toBe(lk);
    expect(resolveSelectedVenue(staff, [{ id: lk }], "all")).toBe(lk);
    expect(resolveSelectedVenue(staff, [{ id: lk }], sw)).toBe(lk);
  });

  it("only allows same-site next paths", () => {
    expect(safeNextPath("/admin/week?start=2026-10-12")).toBe("/admin/week?start=2026-10-12");
    expect(safeNextPath("https://evil.example")).toBe("/admin");
    expect(safeNextPath("//evil.example")).toBe("/admin");
    expect(safeNextPath("/login")).toBe("/admin");
  });
});

describe("audit log", () => {
  it("records actor and filters by venue and search", async () => {
    await audit(db, { user: manager, action: "booking.cancel", entityType: "booking", entityId: "b1", venueId: sw, before: { at: new Date(0) } });
    await audit(db, { user: null, action: "job.run", entityType: "job" });
    const swRows = await listAudit(db, { venueIds: [sw] });
    expect(swRows.map((r) => r.actor)).toEqual(["manager.southwoodford@demo.baypook"]);
    expect(swRows[0].before).toEqual({ at: "1970-01-01T00:00:00.000Z" });
    expect((await listAudit(db, { venueIds: [lk] })).length).toBe(0);
    expect((await listAudit(db, { search: "job" }))[0].actor).toBe("system");
  });
});
