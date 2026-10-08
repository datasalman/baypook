/**
 * Helpers for the public API (`/api/v1`): JSON responses, the error envelope
 * `{ error: { code, message, limit? } }`, CORS for the allow-listed origins and
 * rate limits: a light in-memory one per IP and instance, and, for the routes that
 * create things (quote, holds, checkout), a shared one in the database
 * (`@/lib/rate-limit`) keyed by a hash of the IP.
 */
import { ZodError } from "zod";
import { getDb } from "@/db";
import { env } from "@/lib/env";
import { clientKeyForIp, consumeRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { PricingError } from "@/core/pricing";
import { HoldError } from "@/server/holds";
import { AvailabilityError } from "@/server/availability";
import { BookingError } from "@/server/bookings";

export type ApiErrorCode =
  | "INVALID"
  | "NOT_FOUND"
  | "LIMIT"
  | "GONE"
  | "HOLD_EXPIRED"
  | "UNAVAILABLE"
  | "RATE_LIMITED"
  | "FORBIDDEN"
  | "STATE"
  | "UNKNOWN";

export const STATUS_FOR_CODE: Record<ApiErrorCode, number> = {
  INVALID: 400,
  NOT_FOUND: 404,
  LIMIT: 409,
  GONE: 409,
  HOLD_EXPIRED: 410,
  UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  FORBIDDEN: 403,
  STATE: 409,
  UNKNOWN: 500,
};

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function apiError(code: ApiErrorCode, message: string, status?: number, extra: { limit?: number } = {}): Response {
  const error: { code: ApiErrorCode; message: string; limit?: number } = { code, message };
  if (typeof extra.limit === "number") error.limit = extra.limit;
  return json({ error }, { status: status ?? STATUS_FOR_CODE[code] });
}

/** Thrown inside handlers to return a specific API error. */
export class ApiError extends Error {
  code: ApiErrorCode;
  limit?: number;
  constructor(code: ApiErrorCode, message: string, limit?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    if (limit !== undefined) this.limit = limit;
  }
}

function zodMessage(e: ZodError): string {
  const issue = e.issues[0];
  if (!issue) return "The request is not valid.";
  const path = issue.path.map(String).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Map any thrown error to an API error response. */
export function errorResponse(e: unknown): Response {
  if (e instanceof ApiError) return apiError(e.code, e.message, undefined, { limit: e.limit });
  if (e instanceof ZodError) return apiError("INVALID", zodMessage(e));
  if (e instanceof HoldError || e instanceof PricingError || e instanceof AvailabilityError || e instanceof BookingError) {
    return apiError(e.code, e.message, undefined, { limit: e.limit });
  }
  console.error("[api] unexpected error:", e);
  return apiError("UNKNOWN", "Something went wrong on our side. Please try again.");
}

// ---------- CORS ----------

export function corsHeaders(req: Request): Headers {
  const headers = new Headers();
  headers.set("Vary", "Origin");
  const origin = req.headers.get("origin");
  if (origin && env.allowedOrigins().includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Accept");
    headers.set("Access-Control-Max-Age", "600");
  }
  return headers;
}

function withHeaders(res: Response, extra: Headers): Response {
  extra.forEach((value, key) => {
    if (key.toLowerCase() === "vary") {
      const existing = res.headers.get("Vary");
      res.headers.set("Vary", existing && !/\borigin\b/i.test(existing) ? `${existing}, ${value}` : value);
    } else {
      res.headers.set(key, value);
    }
  });
  return res;
}

/** The CORS preflight handler: `export const OPTIONS = preflight;` in each route. */
export async function preflight(req: Request): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

// ---------- rate limit ----------

const WINDOW_MS = 60_000;
export const RATE_LIMITS = { read: 120, write: 20 } as const;
const hits = new Map<string, number[]>();

export function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** The hashed client key for this request's IP (HMAC with APP_SECRET; raw IPs are never stored). */
export function clientKey(req: Request): string {
  return clientKeyForIp(getClientIp(req));
}

/** Sliding window: true when this request is allowed. */
export function rateLimit(key: string, limit: number, now = Date.now()): boolean {
  return rateLimitRetryAfter(key, limit, now) === 0;
}

/** Sliding window: 0 when this request is allowed (and counted), otherwise the seconds until it would be. */
function rateLimitRetryAfter(key: string, limit: number, now: number): number {
  const since = now - WINDOW_MS;
  const list = (hits.get(key) ?? []).filter((t) => t > since);
  if (list.length >= limit) {
    hits.set(key, list);
    return Math.max(1, Math.ceil((list[0] + WINDOW_MS - now) / 1000));
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (!v.some((t) => t > since)) hits.delete(k);
  }
  return 0;
}

function rateLimited(retryAfterSeconds: number): Response {
  const res = apiError("RATE_LIMITED", "Too many requests. Please wait a minute and try again.");
  res.headers.set("Retry-After", String(retryAfterSeconds));
  return res;
}

/** Tests only. */
export function resetRateLimits(): void {
  hits.clear();
}

// ---------- wrapper ----------

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/** A shared (database) rate limit for one route: `limit` requests per `windowSeconds` per IP. */
export type DbRateLimit = { route: string; limit: number; windowSeconds: number };

/** The shared limits for the public routes that create things. */
export const DB_RATE_LIMITS = {
  quote: { route: "quote", limit: 60, windowSeconds: 60 },
  holds: { route: "holds", limit: 10, windowSeconds: 60 },
  checkout: { route: "checkout", limit: 10, windowSeconds: 60 },
} as const satisfies Record<string, DbRateLimit>;

/**
 * Wrap a route handler: rate limit (120 reads or 20 writes per minute per IP and
 * instance, then the optional shared database limit), error mapping, and CORS
 * headers on every response. A refusal is `RATE_LIMITED` (429) with `Retry-After`.
 */
export function withApi<C = unknown>(handler: Handler<C>, opts: { dbRateLimit?: DbRateLimit } = {}): Handler<C> {
  return async (req, ctx) => {
    const cors = corsHeaders(req);
    const write = req.method !== "GET" && req.method !== "HEAD";
    const ip = getClientIp(req);
    const retryAfter = rateLimitRetryAfter(`${write ? "w" : "r"}:${ip}`, write ? RATE_LIMITS.write : RATE_LIMITS.read, Date.now());
    if (retryAfter > 0) return withHeaders(rateLimited(retryAfter), cors);
    let res: Response;
    try {
      const limit = opts.dbRateLimit;
      if (limit) {
        const result = await consumeRateLimit(await getDb(), {
          key: rateLimitKey(limit.route, clientKeyForIp(ip)),
          limit: limit.limit,
          windowSeconds: limit.windowSeconds,
        });
        if (!result.allowed) return withHeaders(rateLimited(result.retryAfterSeconds), cors);
      }
      res = await handler(req, ctx);
    } catch (e) {
      res = errorResponse(e);
    }
    return withHeaders(res, cors);
  };
}

/** Parse a JSON body; a missing or broken body is INVALID. */
export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text.trim()) throw new ApiError("INVALID", "The request body is empty.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError("INVALID", "The request body is not valid JSON.");
  }
}
