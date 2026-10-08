/**
 * README screenshots, saved as PNGs under docs/screenshots/. Not part of the test run:
 * playwright.config.ts ignores this file unless SCREENSHOTS=1.
 *
 *   SCREENSHOTS=1 npx playwright test tests/e2e/screenshots.spec.ts
 *
 * It makes a few bookings of its own (through the public API and /book) on one day a
 * few days ahead, so Today, Week and the Outbox have something to show.
 */
import path from "node:path";
import { test, type Page } from "@playwright/test";
import {
  addDays,
  bookWorkshopViaApi,
  customerHeaders,
  expect,
  fakeIp,
  getService,
  londonDate,
  londonTime,
  option,
  payOnDemoCheckout,
  pickDayOnBook,
  postHold,
  sessionAt,
  signIn,
  SW,
  weekdayOf,
} from "./helpers";

const OUT = path.join(__dirname, "..", "..", "docs", "screenshots");
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

test.use({ ...customerHeaders(), viewport: PHONE, deviceScaleFactor: 2 });
test.describe.configure({ mode: "serial", timeout: 300_000 });

// Four days ahead (past the parties' 48 hours), skipping Monday when South Woodford is closed.
let day = addDays(londonDate(), 4);
while (weekdayOf(day) === 1) day = addDays(day, 1);

// The Next.js dev-mode badge is not part of the app.
const HIDE = "nextjs-portal { display: none !important; }";

async function shot(page: Page, name: string, opts: { fullPage?: boolean } = {}): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), animations: "disabled", style: HIDE, fullPage: opts.fullPage ?? false });
}

let partyBookingId = "";
let bookReference = "";

test("sample bookings for the day", async ({ page, request }) => {
  const workshops = await getService(request, SW, "classic-workshops");
  const slime = option(workshops, "Slime Workshop");
  const decoden = option(workshops, "Decoden Craft Workshop");
  const sample = [
    { time: "10:00", firstName: "Amina", lastName: "Khan", lines: [{ optionId: slime.id, qty: 3 }] },
    { time: "11:00", firstName: "Tom", lastName: "Price", lines: [{ optionId: slime.id, qty: 1 }, { optionId: decoden.id, qty: 1 }] },
    { time: "16:00", firstName: "Grace", lastName: "Okafor", lines: [{ optionId: decoden.id, qty: 2 }] },
  ];
  for (const b of sample) {
    const session = await sessionAt(request, SW, workshops.id, day, b.time);
    await bookWorkshopViaApi(page, {
      venue: SW,
      serviceId: workshops.id,
      sessionId: session.id,
      lines: b.lines,
      firstName: b.firstName,
      lastName: b.lastName,
      email: `${b.firstName.toLowerCase()}.shots@example.com`,
    });
  }

  // A Slime Party at 13:00 with two extra children.
  const party = await getService(request, SW, "slime-party");
  const slots = await request.get(`/api/v1/venues/${SW}/availability?service=${party.id}&from=${day}&to=${day}`);
  const starts = ((await slots.json()) as { days: { starts: { startsAt: string }[] }[] }).days.flatMap((d) => d.starts);
  const start = starts.find((s) => londonTime(s.startsAt) === "13:00") ?? starts[0];
  const extra = party.addOns.find((a) => a.name === "Extra child");
  const ip = fakeIp();
  const hold = await postHold(
    request,
    {
      venue: SW,
      service: party.id,
      startsAt: start.startsAt,
      lines: [{ optionId: party.options[0].id, qty: 1 }],
      addOns: extra ? [{ addOnId: extra.id, qty: 2 }] : [],
    },
    ip,
  );
  expect(hold.status, JSON.stringify(hold.body)).toBe(200);
  const res = await request.post("/api/v1/checkout", {
    headers: { "x-forwarded-for": ip },
    data: {
      holdId: hold.body.hold?.id,
      customer: { firstName: "Hannah", lastName: "Webb", email: "hannah.shots@example.com", phone: "07700 900777" },
      birthdayChild: { firstName: "Isla", age: 7 },
      message: "One child is allergic to nuts.",
      accept: { terms: true, waiver: true },
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const out = (await res.json()) as { bookingId: string; checkoutUrl: string };
  partyBookingId = out.bookingId;
  await payOnDemoCheckout(page, out.checkoutUrl);
});

test("login", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in as owner" })).toBeVisible();
  await shot(page, "login");
});

test("/book: time, details and thanks", async ({ page }) => {
  await page.goto("/book");
  await page.getByRole("button", { name: /South Woodford/ }).click();
  await page.getByRole("button", { name: /Classic Workshops/ }).click();
  await pickDayOnBook(page, day);
  await expect(page.getByRole("heading", { name: "What time?" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^15:00/ })).toBeEnabled();
  await shot(page, "book-time");

  await page.getByRole("button", { name: /^15:00/ }).click();
  const more = page.getByRole("button", { name: /^One more: Slime Workshop/ });
  await more.click();
  await more.click();
  const cont = page.getByRole("button", { name: "Continue", exact: true });
  await expect(cont).toBeEnabled();
  await cont.click();

  await expect(page.getByText(/holding your places/i).first()).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("First name").fill("Amelia");
  await page.getByLabel("Last name").fill("Turner");
  await page.getByLabel("Email").fill("amelia.shots@example.com");
  await page.getByLabel("Phone").fill("07700 900888");
  await page.getByLabel(/I agree to the/).check();
  await page.getByLabel(/liability waiver/).check();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "book-details");

  await page.getByRole("button", { name: /^Pay £/ }).click();
  await page.waitForURL(/\/demo\/checkout\//);
  const title = page.getByRole("heading", { name: /^Pay for booking BP-/ });
  bookReference = ((await title.textContent()) ?? "").replace("Pay for booking", "").trim();
  await page.getByRole("button", { name: /^Pay £/ }).click();
  await page.waitForURL(/\/book\/thanks\?.*paid=1/);
  await expect(page.getByRole("heading", { name: "You're booked in" })).toBeVisible({ timeout: 60_000 });
  await shot(page, "book-thanks");
});

test("admin pages", async ({ page, request }) => {
  expect(partyBookingId && bookReference, "the booking steps must run first").toBeTruthy();
  const workshops = await getService(request, SW, "classic-workshops");
  await signIn(page);

  await page.goto(`/admin?date=${day}`);
  await expect(page.getByText("Hannah Webb").first()).toBeVisible();
  await shot(page, "admin-today");

  await page.goto(`/admin/bookings/${partyBookingId}`);
  await expect(page.getByText(/Birthday child/)).toBeVisible();
  await shot(page, "admin-booking");

  await page.goto(`/admin/bookings/new?venue=${SW}&service=${workshops.id}&date=${day}`);
  await expect(page.getByText("Which session?")).toBeVisible();
  await shot(page, "admin-new-booking");

  await page.goto(`/admin/catalogue/${workshops.id}#options`);
  await expect(page.getByRole("heading", { name: "Classic Workshops" }).first()).toBeVisible();
  await shot(page, "admin-catalogue");

  await page.goto("/admin/reports");
  await expect(page.getByRole("heading", { name: "Reports" }).first()).toBeVisible();
  await shot(page, "admin-reports");

  await page.goto(`/admin/outbox?q=${bookReference}`);
  const email = page.getByRole("listitem").filter({ hasText: "Confirmation" }).first();
  await email.locator("summary").first().click();
  await expect(email.locator("iframe")).toBeVisible();
  await email.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const el = document.querySelector("li details[open]");
    if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70);
  });
  await shot(page, "admin-outbox");

  await page.goto("/admin/connections");
  await expect(page.getByRole("heading", { name: "Connections" }).first()).toBeVisible();
  await shot(page, "admin-connections");
});

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP, deviceScaleFactor: 1 });

  test("week", async ({ page }) => {
    await signIn(page);
    const monday = addDays(day, -((weekdayOf(day) + 6) % 7));
    await page.goto(`/admin/week?start=${monday}`);
    await expect(page.getByText(/Isla/).first()).toBeVisible();
    await shot(page, "admin-week-desktop");
  });
});
