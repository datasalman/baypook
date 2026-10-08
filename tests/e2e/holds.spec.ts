/**
 * Holds through the public API: placing one takes the places, releasing it
 * (DELETE /api/v1/holds/:id) gives them back, and the hold-expiry cron runs in demo
 * mode without touching live holds.
 */
import { test, type APIRequestContext } from "@playwright/test";
import { addDays, customerHeaders, expect, fakeIp, firstBookableSession, getService, londonDate, londonTime, option, postHold, sessionAt, SW } from "./helpers";

test.use(customerHeaders());
test.describe.configure({ mode: "serial", timeout: 120_000 });

async function remaining(request: APIRequestContext, serviceId: string, date: string, time: string): Promise<number> {
  return (await sessionAt(request, SW, serviceId, date, time)).remaining;
}

test("releasing a hold gives its places back; the expiry cron keeps live holds", async ({ request }) => {
  const svc = await getService(request, SW, "classic-workshops");
  const slime = option(svc, "Slime Workshop");
  // Three weeks out, so no other spec is using the day.
  const { date, session } = await firstBookableSession(request, SW, svc.id, addDays(londonDate(), 21), 3);
  const time = londonTime(session.startsAt);
  const before = session.remaining;

  const ip = fakeIp();
  const held = await postHold(request, { venue: SW, service: svc.id, sessionId: session.id, lines: [{ optionId: slime.id, qty: 3 }], addOns: [] }, ip);
  expect(held.status, JSON.stringify(held.body)).toBe(200);
  const holdId = held.body.hold?.id ?? "";
  expect(holdId).toMatch(/^[0-9a-f-]{36}$/);
  expect(new Date(held.body.hold?.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now());
  expect(await remaining(request, svc.id, date, time)).toBe(before - 3);

  // The cron only expires lapsed holds: this one stays.
  const cron = await request.get("/api/cron/expire-holds");
  expect(cron.status(), await cron.text()).toBe(200);
  const run = (await cron.json()) as { job: string; status: string; summary: Record<string, unknown> | null; error: string | null };
  expect(run.status).toBe("ok");
  expect(run.summary).toBeTruthy();
  expect(typeof run.summary).toBe("object");
  expect(run.error ?? null).toBeNull();
  expect(await remaining(request, svc.id, date, time)).toBe(before - 3);

  // The customer changes their mind.
  const del = await request.delete(`/api/v1/holds/${holdId}`, { headers: { "x-forwarded-for": ip } });
  expect(del.status()).toBe(200);
  expect(await del.json()).toEqual({ released: true });
  expect(await remaining(request, svc.id, date, time)).toBe(before);

  // Idempotent, unknown ids too.
  const again = await request.delete(`/api/v1/holds/${holdId}`, { headers: { "x-forwarded-for": ip } });
  expect(await again.json()).toEqual({ released: true });
  const unknown = await request.delete("/api/v1/holds/00000000-0000-4000-8000-000000000000", { headers: { "x-forwarded-for": ip } });
  expect(unknown.status()).toBe(200);
  expect(await unknown.json()).toEqual({ released: true });
  expect(await remaining(request, svc.id, date, time)).toBe(before);
});

test("the expiry cron answers with a summary in demo mode", async ({ request }) => {
  const res = await request.get("/api/cron/expire-holds");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { job: string; status: string; summary: { expired: number; bookingsCancelled: number; errors: string[] } };
  expect(body.job).toBe("expire-holds");
  expect(body.status).toBe("ok");
  expect(typeof body.summary.expired).toBe("number");
  expect(typeof body.summary.bookingsCancelled).toBe("number");
  expect(body.summary.errors).toEqual([]);
});
