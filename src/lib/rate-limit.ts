/**
 * A fixed-window rate limit kept in the database (`rate_limits`), so every
 * serverless instance shares one count. The in-memory limiter in `@/lib/api`
 * stays in front of it as a cheap first layer.
 *
 * One atomic statement per request: insert the key with count 1, or, when the
 * key exists, either start a new window (the old one has ended) or add one.
 * Concurrent requests on one key serialise on the primary key, so the count is
 * exact. Only standard SQL (`INSERT … ON CONFLICT … DO UPDATE … RETURNING`), which
 * PGlite and Postgres both run.
 *
 * Client IPs are never stored: callers pass `clientKeyForIp(ip)`, an HMAC of the
 * IP keyed with APP_SECRET.
 */
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";
import { env } from "@/lib/env";

export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterSeconds: number };

/** The client key for an IP: HMAC-SHA256(APP_SECRET, ip), hex. The raw IP is never stored. */
export function clientKeyForIp(ip: string): string {
  return crypto.createHmac("sha256", env.appSecret()).update(ip).digest("hex");
}

/** The `rate_limits` key for a route and a client key. */
export function rateLimitKey(route: string, clientKey: string): string {
  return `${route}:${clientKey}`;
}

/**
 * Count one request against `key` and say whether it is allowed. The first
 * `limit` requests in a window of `windowSeconds` (starting at the first request)
 * are allowed; the rest are refused until the window ends.
 */
export async function consumeRateLimit(
  db: DbOrTx,
  input: { key: string; limit: number; windowSeconds: number; now?: Date },
): Promise<RateLimitResult> {
  const now = input.now ?? new Date();
  const windowMs = input.windowSeconds * 1000;
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() - windowMs).toISOString();
  const ended = sql`${s.rateLimits.windowStart} <= ${cutoffIso}::timestamptz`;

  const [row] = await db
    .insert(s.rateLimits)
    .values({ key: input.key, count: 1, windowStart: now })
    .onConflictDoUpdate({
      target: s.rateLimits.key,
      set: {
        count: sql`CASE WHEN ${ended} THEN 1 ELSE ${s.rateLimits.count} + 1 END`,
        windowStart: sql`CASE WHEN ${ended} THEN ${nowIso}::timestamptz ELSE ${s.rateLimits.windowStart} END`,
      },
    })
    .returning({ count: s.rateLimits.count, windowStart: s.rateLimits.windowStart });

  const count = Number(row.count);
  const windowEnds = row.windowStart.getTime() + windowMs;
  const allowed = count <= input.limit;
  return {
    allowed,
    remaining: Math.max(0, input.limit - count),
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((windowEnds - now.getTime()) / 1000)),
  };
}
