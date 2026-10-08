/**
 * The public API end to end in demo mode, calling the route handlers directly
 * against a seeded in-memory database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

import { and, eq } from "drizzle-orm";
import { createTestDb } from "@/db";
import * as s from "@/db/schema";
import { addMinutes, zonedDateTime } from "@/core/time";
import { resetRateLimits } from "@/lib/api";
import { clientKeyForIp } from "@/lib/rate-limit";
import { confirmBookingPaid } from "@/server/bookings";
import { expireHoldsJob } from "@/server/jobs";
import { GET as venuesGET } from "@/app/api/v1/venues/route";
import { GET as servicesGET } from "@/app/api/v1/venues/[slug]/services/route";
import { GET as availabilityGET } from "@/app/api/v1/venues/[slug]/availability/route";
import { POST as quotePOST } from "@/app/api/v1/quote/route";
import { POST as holdsPOST } from "@/app/api/v1/holds/route";
import { DELETE as holdDELETE } from "@/app/api/v1/holds/[id]/route";
import { POST as checkoutPOST } from "@/app/api/v1/checkout/route";
import { GET as summaryGET } from "@/app/api/v1/bookings/[token]/summary/route";
import { POST as webhookPOST } from "@/app/api/webhooks/stripe/[venue]/route";
import { GET as cronGET } from "@/app/api/cron/expire-holds/route";

const NOW = new Date("2026-10-10T09:00:00Z");
const DAY = "2026-10-24"; // Saturday, BST
const BASE = "http://localhost:3000";

type Json = Record<string, unknown>;
type ServiceJson = { id: string; slug: string; kind: string; options: { id: string; name: string }[]; addOns: { id: string; name: string }[] };
type SessionJson = { id: string; startsAt: string; remaining: number; bookable: boolean; reason: string | null };

function req(path: string, init: RequestInit & { origin?: string } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.origin) headers.set("origin", init.origin);
  if (init.body) headers.set("content-type", "application/json");
  return new Request(`${BASE}${path}`, { ...init, headers });
}

const params = <T,>(p: T) => ({ params: Promise.resolve(p) });

async function body<T = Json>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

let services: ServiceJson[];
const workshops = () => services.find((x) => x.slug === "classic-workshops")!;
const party = () => services.find((x) => x.slug === "slime-party")!;
const slimeOption = () => workshops().options.find((o) => o.name === "Slime Workshop")!.id;

async function sessionsOn(day = DAY): Promise<SessionJson[]> {
  const res = await availabilityGET(
    req(`/api/v1/venues/south-woodford/availability?service=classic-workshops&from=${day}&to=${day}`),
    params({ slug: "south-woodford" }),
  );
  expect(res.status).toBe(200);
  const data = await body<{ kind: string; days: { date: string; sessions: SessionJson[] }[] }>(res);
  expect(data.kind).toBe("session");
  return data.days[0].sessions;
}

async function sessionAt(time: string): Promise<SessionJson> {
  const at = zonedDateTime(DAY, time).toISOString();
  const found = (await sessionsOn()).find((x) => x.startsAt === at);
  if (!found) throw new Error(`no session at ${time}`);
  return found;
}

async function holdWorkshop(time: string, qty: number): Promise<Response> {
  const session = await sessionAt(time);
  return holdsPOST(
    req("/api/v1/holds", {
      method: "POST",
      body: JSON.stringify({
        venue: "south-woodford",
        service: workshops().id,
        sessionId: session.id,
        lines: [{ optionId: slimeOption(), qty }],
        addOns: [],
      }),
    }),
    undefined,
  );
}

async function holdParty(time: string): Promise<Response> {
  return holdsPOST(
    req("/api/v1/holds", {
      method: "POST",
      body: JSON.stringify({
        venue: "south-woodford",
        service: party().slug,
        startsAt: zonedDateTime(DAY, time).toISOString(),
        lines: [{ optionId: party().options[0].id, qty: 1 }],
        addOns: [],
      }),
    }),
    undefined,
  );
}

function checkout(holdId: string, extra: Json = {}): Promise<Response> {
  return checkoutPOST(
    req("/api/v1/checkout", {
      method: "POST",
      body: JSON.stringify({
        holdId,
        customer: { firstName: "Amina", lastName: "Khan", email: "Amina@Example.com", phone: "07700 900123" },
        accept: { terms: true, waiver: true },
        returnUrl: "http://localhost:3000/book/thanks",
        ...extra,
      }),
    }),
    undefined,
  );
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  holder.db = await createTestDb({ seed: true });
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  resetRateLimits();
  vi.setSystemTime(NOW);
});

describe("public API (demo mode)", () => {
  it("lists both venues as bookable online", async () => {
    const res = await venuesGET(req("/api/v1/venues"), undefined);
    expect(res.status).toBe(200);
    const data = await body<{ venues: { slug: string; onlineBookable: boolean; timezone: string; postcode: string }[] }>(res);
    expect(data.venues.map((v) => v.slug).sort()).toEqual(["lakeside", "south-woodford"]);
    expect(data.venues.every((v) => v.onlineBookable)).toBe(true);
    expect(data.venues[0].timezone).toBe("Europe/London");
  });

  it("includes the organisation's links, waiver and contact details with the venues", async () => {
    const res = await venuesGET(req("/api/v1/venues"), undefined);
    const data = await body<{ organisation: Record<string, unknown> }>(res);
    const org = data.organisation;
    expect(Object.keys(org).sort()).toEqual(
      ["contactEmail", "contactPhone", "name", "privacyUrl", "termsUrl", "termsVersion", "timezone", "waiverText", "waiverVersion", "whatsappUrl"],
    );
    expect(org.termsUrl).toBe("https://slimedom.com/terms");
    expect(org.privacyUrl).toBe("https://slimedom.com/privacy");
    expect(org.termsVersion).toBe(1);
    expect(org.waiverVersion).toBe(1);
    expect(typeof org.waiverText).toBe("string");
    expect((org.waiverText as string).length).toBeGreaterThan(0);
    expect(org.timezone).toBe("Europe/London");
  });

  it("lists the services with options and add-ons", async () => {
    const res = await servicesGET(req("/api/v1/venues/south-woodford/services"), params({ slug: "south-woodford" }));
    expect(res.status).toBe(200);
    services = (await body<{ services: ServiceJson[] }>(res)).services;
    expect(services).toHaveLength(3);
    expect(workshops().options.map((o) => o.name)).toEqual(expect.arrayContaining(["Slime Workshop", "Decoden Craft Workshop"]));
    expect(party().addOns.map((a) => a.name)).toEqual(expect.arrayContaining(["Extra child", "Food time"]));
    const decoden = (workshops().options as unknown as { name: string; inStoreNote: { menuUrl: string } | null }[]).find(
      (o) => o.name === "Decoden Craft Workshop",
    );
    expect(decoden?.inStoreNote?.menuUrl).toContain("decoden-menu");
  });

  it("404s for an unknown venue", async () => {
    const res = await servicesGET(req("/api/v1/venues/nowhere/services"), params({ slug: "nowhere" }));
    expect(res.status).toBe(404);
    expect((await body<{ error: { code: string } }>(res)).error.code).toBe("NOT_FOUND");
  });

  it("shows the workshop sessions with 10 places left", async () => {
    const sessions = await sessionsOn();
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((x) => x.remaining === 10 && x.bookable)).toBe(true);
  });

  it("rejects a window longer than 62 days and bad dates", async () => {
    const long = await availabilityGET(
      req("/api/v1/venues/south-woodford/availability?service=classic-workshops&from=2026-10-10&to=2026-12-31"),
      params({ slug: "south-woodford" }),
    );
    expect(long.status).toBe(400);
    const bad = await availabilityGET(
      req("/api/v1/venues/south-woodford/availability?service=classic-workshops&from=24-10-2026"),
      params({ slug: "south-woodford" }),
    );
    expect(bad.status).toBe(400);
  });

  it("quotes from the server catalogue", async () => {
    const res = await quotePOST(
      req("/api/v1/quote", {
        method: "POST",
        body: JSON.stringify({ venue: "south-woodford", service: workshops().id, lines: [{ optionId: slimeOption(), qty: 2 }], addOns: [] }),
      }),
      undefined,
    );
    expect(res.status).toBe(200);
    const { quote } = await body<{ quote: { totalPence: number; places: number } }>(res);
    expect(quote).toMatchObject({ totalPence: 3400, places: 2 });
  });

  let token = "";

  it("holds two places, checks out, confirms, and summarises", async () => {
    const holdRes = await holdWorkshop("14:00", 2);
    expect(holdRes.status).toBe(200);
    const { hold, quote } = await body<{ hold: { id: string; expiresAt: string }; quote: { totalPence: number } }>(holdRes);
    expect(quote.totalPence).toBe(3400);
    expect(new Date(hold.expiresAt).getTime()).toBe(addMinutes(NOW, 15).getTime());

    const coRes = await checkout(hold.id);
    expect(coRes.status).toBe(200);
    const co = await body<{ bookingId: string; reference: string; checkoutUrl: string }>(coRes);
    expect(co.reference).toMatch(/^BP-[2-9A-Z]{5}$/);
    expect(co.checkoutUrl).toContain(`/demo/checkout/${co.bookingId}`);

    const db = holder.db!;
    const [pending] = await db.select().from(s.bookings).where(eq(s.bookings.id, co.bookingId));
    expect(pending).toMatchObject({ status: "pending", paymentStatus: "unpaid", places: 2, totalPence: 3400 });
    const [customer] = await db.select().from(s.customers).where(eq(s.customers.id, pending.customerId));
    expect(customer.email).toBe("amina@example.com");
    const [setting] = await db.select().from(s.settings).where(eq(s.settings.key, `demo.checkout.${co.bookingId}`));
    expect((setting.value as { successUrl: string }).successUrl).toContain("paid=1");

    // The pending booking still holds the places (the hold is not counted twice).
    expect((await sessionAt("14:00")).remaining).toBe(8);

    const res = await confirmBookingPaid(db, {
      bookingId: co.bookingId,
      payment: { provider: "demo", providerCheckoutId: `demo_cs_${co.bookingId}`, amountPence: 3400, currency: "gbp" },
    });
    expect(res.alreadyConfirmed).toBe(false);
    expect(res.booking).toMatchObject({ status: "confirmed", paymentStatus: "paid", paidPence: 3400 });
    token = res.booking.token;

    const again = await confirmBookingPaid(db, {
      bookingId: co.bookingId,
      payment: { provider: "demo", providerCheckoutId: `demo_cs_${co.bookingId}`, amountPence: 3400, currency: "gbp" },
    });
    expect(again.alreadyConfirmed).toBe(true);

    const emails = await db
      .select()
      .from(s.notifications)
      .where(and(eq(s.notifications.bookingId, co.bookingId), eq(s.notifications.template, "confirmation")));
    expect(emails).toHaveLength(1);
    expect(emails[0].attachments.some((a) => a.filename.endsWith(".ics"))).toBe(true);
    const cal = await db.select().from(s.calendarLog).where(eq(s.calendarLog.bookingId, co.bookingId));
    expect(cal.length).toBeGreaterThanOrEqual(1);
    const [hold2] = await db.select().from(s.holds).where(eq(s.holds.id, hold.id));
    expect(hold2.status).toBe("converted");
    const payments = await db.select().from(s.payments).where(eq(s.payments.bookingId, co.bookingId));
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe("succeeded");

    const sumRes = await summaryGET(req(`/api/v1/bookings/${token}/summary`), params({ token }));
    expect(sumRes.status).toBe(200);
    const summary = await body<Json>(sumRes);
    expect(summary).toMatchObject({
      reference: co.reference,
      status: "confirmed",
      paymentStatus: "paid",
      service: { name: "Classic Workshops", kind: "session" },
      totalPence: 3400,
      paidPence: 3400,
      customer: { firstName: "Amina" },
      paymentMethod: "online_card",
      inStoreNote: null,
      timezone: "Europe/London",
      addOns: [],
    });
    expect(summary.lines).toEqual([{ name: "Slime Workshop", qty: 2, unitPence: 1700, totalPence: 3400 }]);
    expect((summary.venue as Json).slug).toBe("south-woodford");
    expect(summary).not.toHaveProperty("token");
  });

  it("refuses a party over the booked 14:00 session (GONE)", async () => {
    const res = await holdParty("14:00");
    expect(res.status).toBe(409);
    expect((await body<{ error: { code: string } }>(res)).error.code).toBe("GONE");
  });

  it("lets a party take an empty session, which then shows 0 left (room busy)", async () => {
    const res = await holdParty("11:00");
    expect(res.status).toBe(200);
    const eleven = await sessionAt("11:00");
    expect(eleven).toMatchObject({ remaining: 0, bookable: false, reason: "room_busy" });
  });

  it("expires an abandoned hold and frees the places", async () => {
    const holdRes = await holdWorkshop("16:00", 3);
    const { hold } = await body<{ hold: { id: string } }>(holdRes);
    const co = await body<{ bookingId: string }>(await checkout(hold.id));
    expect((await sessionAt("16:00")).remaining).toBe(7);

    const summary = await expireHoldsJob(holder.db!, addMinutes(NOW, 16));
    expect(summary.bookingsCancelled).toBeGreaterThanOrEqual(1);
    const [b] = await holder.db!.select().from(s.bookings).where(eq(s.bookings.id, co.bookingId));
    expect(b).toMatchObject({ status: "cancelled", cancelReason: "expired" });
    expect((await sessionAt("16:00")).remaining).toBe(10);
  });

  it("answers LIMIT with the limit for 11 places", async () => {
    const res = await holdWorkshop("17:00", 11);
    expect(res.status).toBe(409);
    expect((await body<{ error: { code: string; limit: number } }>(res)).error).toMatchObject({ code: "LIMIT", limit: 10 });
  });

  it("answers HOLD_EXPIRED when checking out a lapsed hold", async () => {
    const { hold } = await body<{ hold: { id: string } }>(await holdWorkshop("17:00", 1));
    vi.setSystemTime(addMinutes(NOW, 20));
    const res = await checkout(hold.id);
    expect(res.status).toBe(410);
    expect((await body<{ error: { code: string } }>(res)).error.code).toBe("HOLD_EXPIRED");
  });

  it("validates the checkout body", async () => {
    const { hold } = await body<{ hold: { id: string } }>(await holdWorkshop("12:00", 1));
    const res = await checkout(hold.id, { accept: { terms: true, waiver: false } });
    expect(res.status).toBe(400);
    expect((await body<{ error: { code: string; message: string } }>(res)).error).toMatchObject({ code: "INVALID" });
    // Releasing the hold early is idempotent.
    for (let i = 0; i < 2; i++) {
      const del = await holdDELETE(req(`/api/v1/holds/${hold.id}`, { method: "DELETE" }), params({ id: hold.id }));
      expect(await body(del)).toEqual({ released: true });
    }
    const unknown = await holdDELETE(req("/api/v1/holds/nope", { method: "DELETE" }), params({ id: "nope" }));
    expect(await body(unknown)).toEqual({ released: true });
    const [row] = await holder.db!.select().from(s.holds).where(eq(s.holds.id, hold.id));
    expect(row.status).toBe("released");
  });

  it("404s for an unknown summary token", async () => {
    const t = "x".repeat(43);
    const res = await summaryGET(req(`/api/v1/bookings/${t}/summary`), params({ token: t }));
    expect(res.status).toBe(404);
    expect((await body<{ error: { code: string } }>(res)).error.code).toBe("NOT_FOUND");
  });

  it("sends CORS headers only to allowed origins", async () => {
    const ok = await venuesGET(req("/api/v1/venues", { origin: "http://localhost:3000" }), undefined);
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(ok.headers.get("vary")).toContain("Origin");
    const other = await venuesGET(req("/api/v1/venues", { origin: "https://evil.example" }), undefined);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rate-limits writes per IP", async () => {
    let last: Response | null = null;
    for (let i = 0; i < 21; i++) {
      last = await quotePOST(
        req("/api/v1/quote", { method: "POST", body: "{}", headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } }),
        undefined,
      );
    }
    expect(last!.status).toBe(429);
    expect((await body<{ error: { code: string } }>(last!)).error.code).toBe("RATE_LIMITED");
  });

  it("caps active holds per client at 3 and frees a slot on release", async () => {
    const ip = "198.51.100.7";
    const day = "2026-10-31";
    const res = await availabilityGET(
      req(`/api/v1/venues/south-woodford/availability?service=classic-workshops&from=${day}&to=${day}`),
      params({ slug: "south-woodford" }),
    );
    const session = (await body<{ days: { sessions: SessionJson[] }[] }>(res)).days[0].sessions.find((x) => x.bookable)!;
    const hold = () =>
      holdsPOST(
        req("/api/v1/holds", {
          method: "POST",
          headers: { "x-forwarded-for": ip },
          body: JSON.stringify({
            venue: "south-woodford",
            service: workshops().id,
            sessionId: session.id,
            lines: [{ optionId: slimeOption(), qty: 1 }],
            addOns: [],
          }),
        }),
        undefined,
      );

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await hold();
      expect(r.status).toBe(200);
      ids.push((await body<{ hold: { id: string } }>(r)).hold.id);
    }
    const fourth = await hold();
    expect(fourth.status).toBe(409);
    expect((await body<{ error: Json }>(fourth)).error).toEqual({
      code: "LIMIT",
      message: "You already have 3 bookings on hold. Finish or wait for them to run out.",
      limit: 3,
    });

    // The hold stores only the hashed IP.
    const [row] = await holder.db!.select().from(s.holds).where(eq(s.holds.id, ids[0]));
    expect(row.clientKey).toBe(clientKeyForIp(ip));
    expect(row.clientKey).not.toContain(ip);

    // Another client is not affected.
    const other = await holdsPOST(
      req("/api/v1/holds", {
        method: "POST",
        headers: { "x-forwarded-for": "198.51.100.8" },
        body: JSON.stringify({ venue: "south-woodford", service: workshops().id, sessionId: session.id, lines: [{ optionId: slimeOption(), qty: 1 }], addOns: [] }),
      }),
      undefined,
    );
    expect(other.status).toBe(200);

    await holdDELETE(req(`/api/v1/holds/${ids[0]}`, { method: "DELETE" }), params({ id: ids[0] }));
    expect((await hold()).status).toBe(200);
    expect((await hold()).status).toBe(409);

    // Expired holds stop counting.
    vi.setSystemTime(addMinutes(NOW, 16));
    expect((await hold()).status).toBe(200);
  });

  it("rate-limits hold requests per IP across instances (database), with Retry-After", async () => {
    const send = () =>
      holdsPOST(req("/api/v1/holds", { method: "POST", body: "{}", headers: { "x-forwarded-for": "198.51.100.9" } }), undefined);
    for (let i = 0; i < 10; i++) expect((await send()).status).toBe(400);
    resetRateLimits(); // a different serverless instance: only the database remembers
    const refused = await send();
    expect(refused.status).toBe(429);
    expect((await body<{ error: { code: string } }>(refused)).error.code).toBe("RATE_LIMITED");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(refused.headers.get("retry-after"))).toBeLessThanOrEqual(60);

    vi.setSystemTime(new Date(NOW.getTime() + 61_000));
    expect((await send()).status).toBe(400);
  });

  it("rate-limits checkout requests per IP (database)", async () => {
    const send = () =>
      checkoutPOST(req("/api/v1/checkout", { method: "POST", body: "{}", headers: { "x-forwarded-for": "198.51.100.10" } }), undefined);
    for (let i = 0; i < 10; i++) expect((await send()).status).toBe(400);
    expect((await send()).status).toBe(429);
  });

  it("does not use the Stripe webhook in demo mode", async () => {
    const res = await webhookPOST(req("/api/webhooks/stripe/south-woodford", { method: "POST", body: "{}" }), params({ venue: "south-woodford" }));
    expect(res.status).toBe(404);
  });

  it("runs the hold-expiry cron and records the run", async () => {
    const res = await cronGET(req("/api/cron/expire-holds"));
    expect(res.status).toBe(200);
    const data = await body<{ status: string; summary: { expired: number } }>(res);
    expect(data.status).toBe("ok");
    const runs = await holder.db!.select().from(s.jobRuns).where(eq(s.jobRuns.job, "expire-holds"));
    expect(runs.some((r) => r.status === "ok" && r.triggeredBy === "cron")).toBe(true);
  });
});
