import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";

const holder = vi.hoisted(() => {
  process.env.BAYPOOK_MODE = "demo";
  return { db: null as Db | null };
});

vi.mock("@/db", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/db")>();
  return {
    ...mod,
    getDb: async () => {
      if (!holder.db) throw new Error("test db not ready");
      return holder.db;
    },
  };
});

import { eq } from "drizzle-orm";
import { createTestDb } from "@/db";
import * as s from "@/db/schema";
import { json, resetRateLimits, withApi } from "@/lib/api";
import { clientKeyForIp, consumeRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { retentionJob } from "@/server/jobs-retention";
import { createSession, SESSION_IDLE_TIMEOUT_MS } from "@/server/auth";

const T0 = new Date("2026-10-10T09:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

let db: Db;

beforeAll(async () => {
  db = await createTestDb({ seed: true });
  holder.db = db;
});

beforeEach(() => {
  resetRateLimits();
});

describe("consumeRateLimit", () => {
  it("allows the limit, then refuses with the seconds left in the window", async () => {
    const key = rateLimitKey("test", "a");
    for (let i = 0; i < 3; i++) {
      const r = await consumeRateLimit(db, { key, limit: 3, windowSeconds: 60, now: at(i) });
      expect(r).toEqual({ allowed: true, remaining: 2 - i, retryAfterSeconds: 0 });
    }
    const refused = await consumeRateLimit(db, { key, limit: 3, windowSeconds: 60, now: at(20) });
    expect(refused).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 40 });
    // Refusals keep counting inside the window.
    expect((await consumeRateLimit(db, { key, limit: 3, windowSeconds: 60, now: at(59) })).allowed).toBe(false);
  });

  it("starts a new window once the old one has ended", async () => {
    const key = rateLimitKey("test", "b");
    for (let i = 0; i < 2; i++) await consumeRateLimit(db, { key, limit: 2, windowSeconds: 60, now: at(0) });
    expect((await consumeRateLimit(db, { key, limit: 2, windowSeconds: 60, now: at(30) })).allowed).toBe(false);
    const fresh = await consumeRateLimit(db, { key, limit: 2, windowSeconds: 60, now: at(60) });
    expect(fresh).toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 0 });
    const [row] = await db.select().from(s.rateLimits).where(eq(s.rateLimits.key, key));
    expect(row.count).toBe(1);
    expect(row.windowStart.toISOString()).toBe(at(60).toISOString());
  });

  it("keeps separate counts per key", async () => {
    const a = rateLimitKey("test", "c1");
    const b = rateLimitKey("test", "c2");
    await consumeRateLimit(db, { key: a, limit: 1, windowSeconds: 60, now: at(0) });
    expect((await consumeRateLimit(db, { key: a, limit: 1, windowSeconds: 60, now: at(1) })).allowed).toBe(false);
    expect((await consumeRateLimit(db, { key: b, limit: 1, windowSeconds: 60, now: at(1) })).allowed).toBe(true);
  });

  it("counts concurrent requests exactly", async () => {
    const key = rateLimitKey("test", "d");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => consumeRateLimit(db, { key, limit: 5, windowSeconds: 60, now: at(0) })),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });
});

describe("client keys", () => {
  it("hash the IP with APP_SECRET and never store it", async () => {
    const ip = "198.51.100.23";
    const k = clientKeyForIp(ip);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(k).not.toContain(ip);
    expect(clientKeyForIp(ip)).toBe(k);
    expect(clientKeyForIp("198.51.100.24")).not.toBe(k);

    const handler = withApi(async () => json({ ok: true }), { dbRateLimit: { route: "probe", limit: 1, windowSeconds: 60 } });
    const call = () => handler(new Request("http://localhost/api/v1/probe", { method: "POST", headers: { "x-forwarded-for": ip } }), undefined);
    expect((await call()).status).toBe(200);
    const refused = await call();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");

    const rows = await db.select().from(s.rateLimits);
    const probe = rows.filter((r) => r.key.startsWith("probe:"));
    expect(probe.map((r) => r.key)).toEqual([`probe:${k}`]);
    expect(rows.some((r) => r.key.includes(ip))).toBe(false);
  });
});

describe("retention housekeeping", () => {
  it("deletes old rate-limit rows, spent sign-in links and dead admin sessions", async () => {
    const now = new Date("2026-10-10T12:00:00Z");
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);
    await db.insert(s.rateLimits).values([
      { key: "house:old", count: 3, windowStart: hoursAgo(25) },
      { key: "house:new", count: 3, windowStart: hoursAgo(2) },
    ]);
    const [user] = await db.select().from(s.users).where(eq(s.users.email, "owner@demo.baypook"));
    const links = await db
      .insert(s.magicLinks)
      .values([
        { userId: user.id, tokenHash: "used", expiresAt: new Date(now.getTime() + 600_000), usedAt: hoursAgo(0.1) },
        { userId: user.id, tokenHash: "expired", expiresAt: hoursAgo(1) },
        { userId: user.id, tokenHash: "live", expiresAt: new Date(now.getTime() + 600_000) },
      ])
      .returning();
    const fresh = await createSession(db, user.id);
    const idle = await createSession(db, user.id);
    const expired = await createSession(db, user.id);
    const idOf = (t: { sessionToken: string }) => t.sessionToken.split(".")[0];
    await db.update(s.sessionsAuth).set({ lastSeenAt: now }).where(eq(s.sessionsAuth.id, idOf(fresh)));
    await db
      .update(s.sessionsAuth)
      .set({ lastSeenAt: new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS - 60_000) })
      .where(eq(s.sessionsAuth.id, idOf(idle)));
    await db.update(s.sessionsAuth).set({ lastSeenAt: now, expiresAt: hoursAgo(1) }).where(eq(s.sessionsAuth.id, idOf(expired)));

    const res = await retentionJob(db, now);
    expect(res.rateLimitsDeleted).toBeGreaterThanOrEqual(1);
    expect(res.magicLinksDeleted).toBeGreaterThanOrEqual(2);
    expect(res.adminSessionsDeleted).toBe(2);

    const keys = (await db.select().from(s.rateLimits)).map((r) => r.key);
    expect(keys).toContain("house:new");
    expect(keys).not.toContain("house:old");
    const linkIds = (await db.select().from(s.magicLinks)).map((r) => r.id);
    expect(linkIds).toEqual([links[2].id]);
    const sessionIds = (await db.select().from(s.sessionsAuth)).map((r) => r.id);
    expect(sessionIds).toEqual([idOf(fresh)]);
  });
});
