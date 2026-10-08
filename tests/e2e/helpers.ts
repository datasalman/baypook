/**
 * Shared helpers for the demo-mode Playwright specs. Not a spec itself.
 *
 * Every spec talks to the same demo server and database, so specs pick their own days
 * and times and create their own bookings (own references). Dates are 'YYYY-MM-DD' in
 * the venue's timezone (Europe/London), as the API uses them.
 */
import { expect as baseExpect, type APIRequestContext, type Page } from "@playwright/test";

// `npm run demo` is a dev server: the first visit to each page compiles it, so be patient.
export const expect = baseExpect.configure({ timeout: 30_000 });

export const TZ = "Europe/London";
export const SW = "south-woodford";
export const LAKESIDE = "lakeside";

// ---------- fake client addresses ----------
// The public API limits holds and writes per client IP (3 live holds, 20 writes a minute).
// Each spec, and each API helper call, looks like a different customer.

let ipCounter = 0;
/** A fresh documentation-range address for one simulated customer. */
export function fakeIp(): string {
  ipCounter += 1;
  const n = (process.pid * 7 + Date.now() + ipCounter * 13) % 250;
  return `198.51.${(ipCounter % 250) + 1}.${n + 1}`;
}

/** `test.use(customerHeaders())` at the top of a spec gives its browser and request their own IP. */
export function customerHeaders(): { extraHTTPHeaders: Record<string, string> } {
  return { extraHTTPHeaders: { "x-forwarded-for": fakeIp() } };
}

// ---------- dates ----------

/** 'YYYY-MM-DD' of an instant in London. */
export function londonDate(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** "HH:mm" of an ISO instant in London. */
export function londonTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/** The first `weekday` at least `minDaysAhead` days after today (London). */
export function nextWeekday(weekday: number, minDaysAhead: number): string {
  let d = addDays(londonDate(), minDaysAhead);
  while (weekdayOf(d) !== weekday) d = addDays(d, 1);
  return d;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Saturday 17 October", as the booking page labels days. */
export function formatDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "October 2026" */
export function formatMonth(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// ---------- admin ----------

export type DemoUser = "Sign in as owner" | "Sign in as South Woodford manager" | "Sign in as Lakeside staff";

export async function signIn(page: Page, who: DemoUser = "Sign in as owner"): Promise<void> {
  await page.goto("/login");
  await page.getByRole("button", { name: who }).click();
  await page.waitForURL(/\/admin(?!\/login)/);
}

/** The same URL with its `date` query parameter set (the admin wizard and Today read it). */
export function withDate(url: string, date: string): string {
  const u = new URL(url);
  u.searchParams.set("date", date);
  return u.toString();
}

/** The booking id from an admin booking URL. */
export function bookingIdFromUrl(url: string): string {
  const m = /\/admin\/bookings\/([0-9a-f-]{36})/.exec(url);
  if (!m) throw new Error(`Not a booking URL: ${url}`);
  return m[1];
}

// ---------- public API ----------

export type ApiOption = { id: string; name: string; unitPricePence: number };
export type ApiAddOn = { id: string; name: string; pricePence: number; kind: "quantity" | "time"; extraMinutes: number };
export type ApiService = { id: string; slug: string; kind: "session" | "slot"; name: string; options: ApiOption[]; addOns: ApiAddOn[] };
export type ApiSession = { id: string; startsAt: string; endsAt: string; capacity: number; remaining: number; bookable: boolean; reason: string | null };

export async function getService(request: APIRequestContext, venue: string, slug: string): Promise<ApiService> {
  const res = await request.get(`/api/v1/venues/${venue}/services`);
  expect(res.status(), await res.text()).toBe(200);
  const { services } = (await res.json()) as { services: ApiService[] };
  const svc = services.find((s) => s.slug === slug);
  if (!svc) throw new Error(`No service ${slug} at ${venue}`);
  return svc;
}

export function option(svc: ApiService, name: string): ApiOption {
  const o = svc.options.find((x) => x.name === name);
  if (!o) throw new Error(`No option ${name} on ${svc.name}`);
  return o;
}

/** Workshop sessions for a range of days (inclusive). */
export async function sessionsBetween(
  request: APIRequestContext,
  venue: string,
  serviceId: string,
  from: string,
  to: string,
): Promise<{ date: string; sessions: ApiSession[] }[]> {
  const res = await request.get(`/api/v1/venues/${venue}/availability?service=${serviceId}&from=${from}&to=${to}`);
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { kind: "session"; days: { date: string; sessions: ApiSession[] }[] };
  return body.days;
}

export async function sessionAt(request: APIRequestContext, venue: string, serviceId: string, date: string, time: string): Promise<ApiSession> {
  const days = await sessionsBetween(request, venue, serviceId, date, date);
  const s = days.find((d) => d.date === date)?.sessions.find((x) => londonTime(x.startsAt) === time);
  if (!s) throw new Error(`No ${time} session on ${date} at ${venue}`);
  return s;
}

/** The first bookable workshop session with at least `places` free, searching from `from` for `days` days. */
export async function firstBookableSession(
  request: APIRequestContext,
  venue: string,
  serviceId: string,
  from: string,
  places: number,
  days = 30,
): Promise<{ date: string; session: ApiSession }> {
  const list = await sessionsBetween(request, venue, serviceId, from, addDays(from, days));
  for (const d of list) {
    const s = d.sessions.find((x) => x.bookable && x.remaining >= places);
    if (s) return { date: d.date, session: s };
  }
  throw new Error(`No bookable session at ${venue} from ${from}`);
}

/** POST /api/v1/holds as a fresh customer. Returns the parsed body and status. */
export async function postHold(
  request: APIRequestContext,
  body: Record<string, unknown>,
  ip = fakeIp(),
): Promise<{ status: number; body: { hold?: { id: string; expiresAt: string; startsAt: string; endsAt: string }; error?: { code: string; message: string } } }> {
  const res = await request.post("/api/v1/holds", { data: body, headers: { "x-forwarded-for": ip } });
  return { status: res.status(), body: await res.json() };
}

/**
 * Book workshop places through the public API (hold, checkout) and pay on the demo
 * checkout page. Returns the confirmed booking's id and reference.
 */
export async function bookWorkshopViaApi(
  page: Page,
  input: { venue: string; serviceId: string; sessionId: string; lines: { optionId: string; qty: number }[]; firstName: string; lastName: string; email: string },
): Promise<{ bookingId: string; reference: string }> {
  const ip = fakeIp();
  const request = page.request;
  const hold = await postHold(
    request,
    { venue: input.venue, service: input.serviceId, sessionId: input.sessionId, lines: input.lines, addOns: [] },
    ip,
  );
  expect(hold.status, JSON.stringify(hold.body)).toBe(200);
  const res = await request.post("/api/v1/checkout", {
    headers: { "x-forwarded-for": ip },
    data: {
      holdId: hold.body.hold?.id,
      customer: { firstName: input.firstName, lastName: input.lastName, email: input.email, phone: "07700 900456" },
      accept: { terms: true, waiver: true },
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const out = (await res.json()) as { bookingId: string; reference: string; checkoutUrl: string };
  await payOnDemoCheckout(page, out.checkoutUrl);
  return { bookingId: out.bookingId, reference: out.reference };
}

/** On the demo checkout page: press Pay and wait for the thank-you page to confirm. */
export async function payOnDemoCheckout(page: Page, checkoutUrl: string): Promise<void> {
  await page.goto(checkoutUrl);
  await page.getByRole("button", { name: /^Pay £/ }).click();
  await page.waitForURL(/\/book\/thanks\?.*paid=1/);
  await expect(page.getByRole("heading", { name: "You're booked in" })).toBeVisible({ timeout: 60_000 });
}

// ---------- /book ----------

/** On the day step, move to the month of `date`, pick it and continue. */
export async function pickDayOnBook(page: Page, date: string): Promise<void> {
  await expect(page.getByRole("heading", { name: "Which day?" })).toBeVisible({ timeout: 60_000 });
  const month = formatMonth(date);
  for (let i = 0; i < 12; i++) {
    if ((await page.getByText(month, { exact: true }).count()) > 0) break;
    await page.getByRole("button", { name: "Next month" }).click();
  }
  const day = page.getByRole("button", { name: formatDay(date), exact: true });
  await expect(day).toBeEnabled({ timeout: 60_000 });
  await day.click();
  await page.getByRole("button", { name: `Continue with ${formatDay(date)}` }).click();
}
