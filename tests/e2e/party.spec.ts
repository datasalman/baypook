/**
 * A Slime Party with extra children and Food time, booked and paid on /book; the
 * owner gets the confirmation and the "New party" alert; then the one-room conflict
 * rule: the party blocks the workshops it overlaps, and a booked workshop blocks a
 * party over it.
 *
 * Runs against the demo (see playwright.config.ts) on a fresh `.data/e2e`.
 */
import { test, type Page } from "@playwright/test";
import {
  customerHeaders,
  expect,
  fakeIp,
  formatDay,
  getService,
  londonTime,
  nextWeekday,
  pickDayOnBook,
  postHold,
  sessionAt,
  signIn,
  SW,
  withDate,
} from "./helpers";

test.use(customerHeaders());
test.describe.configure({ mode: "serial", timeout: 180_000 });

// A Saturday at least three days ahead: past the parties' 48-hour notice.
const partyDay = nextWeekday(6, 3);
let reference = "";
let partyStart = "";
let partyEnd = "";

async function startOnBook(page: Page, serviceName: RegExp): Promise<void> {
  await page.goto("/book");
  await expect(page.getByRole("heading", { name: "Where would you like to come?" })).toBeVisible();
  await page.getByRole("button", { name: /South Woodford/ }).click();
  // The first visit after a code change recompiles the API routes: allow a minute.
  await expect(page.getByRole("heading", { name: "What are you booking?" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: serviceName }).click();
}

test("a parent books a Slime Party with four extra children and Food time", async ({ page }) => {
  await startOnBook(page, /Slime Party/);
  await pickDayOnBook(page, partyDay);

  // Party flow: children and extras come before the times, so the times fit the length.
  await expect(page.getByRole("heading", { name: "How many children, and any extras?" })).toBeVisible();
  const more = page.getByRole("button", { name: "One more: Extra children" });
  for (let i = 0; i < 4; i++) await more.click();
  await page.getByLabel(/Food time/).check();
  await expect(page.getByText("14 children in total, with 30 extra minutes.")).toBeVisible();
  await expect(page.getByText("£314").first()).toBeVisible();
  await page.getByRole("button", { name: "Continue to times" }).click();

  // Times are two hours long (90 minutes plus 30 for food). Take the first one.
  await expect(page.getByRole("heading", { name: "What time?" })).toBeVisible();
  const first = page.getByRole("button", { name: /^\d{2}:\d{2} to \d{2}:\d{2}$/ }).first();
  await expect(first).toBeVisible();
  const label = (await first.getAttribute("aria-label")) ?? "";
  [partyStart, partyEnd] = label.split(" to ");
  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  expect(minutes(partyEnd) - minutes(partyStart)).toBe(120);
  await first.click();

  // Details, with the birthday child.
  await expect(page.getByText(/holding your/i).first()).toBeVisible({ timeout: 30_000 });
  await page.locator("#f-firstName").fill("Priya");
  await page.getByLabel("Last name").fill("Shah");
  await page.getByLabel("Email").fill("priya.party.e2e@example.com");
  await page.getByLabel("Phone").fill("07700 900321");
  const child = page.getByRole("group", { name: "The birthday child" });
  await child.getByLabel("First name").fill("Maya");
  await child.getByLabel("Age they will be").fill("8");
  await page.getByLabel(/I agree to the/).check();
  await page.getByLabel(/liability waiver/).check();
  await page.getByRole("button", { name: "Pay £314" }).click();

  await page.waitForURL(/\/demo\/checkout\//);
  const title = page.getByRole("heading", { name: /^Pay for booking BP-/ });
  reference = ((await title.textContent()) ?? "").replace("Pay for booking", "").trim();
  expect(reference).toMatch(/^BP-[A-Z0-9]+$/);
  await page.getByRole("button", { name: /^Pay £314/ }).click();

  await page.waitForURL(/\/book\/thanks\?.*paid=1/);
  await expect(page.getByRole("heading", { name: "You're booked in" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(reference)).toBeVisible();
  await expect(page.getByText("Slime Party", { exact: true })).toBeVisible();
  await expect(page.getByText("4 × Extra child")).toBeVisible();
  await expect(page.getByText("1 × Food time")).toBeVisible();
  await expect(page.getByText(`${partyStart} to ${partyEnd}`)).toBeVisible();
  const paid = page.locator("p").filter({ has: page.getByText("Paid", { exact: true }) });
  await expect(paid).toContainText("£314");
});

test("the owner sees the confirmation and the New party alert in the Outbox", async ({ page }) => {
  expect(reference, "the party test must run first").not.toBe("");
  await signIn(page);
  await page.goto(`/admin/outbox?q=${reference}`);
  const emails = page.getByRole("listitem").filter({ hasText: reference });
  await expect(emails.filter({ hasText: "Confirmation" }).first()).toBeVisible();
  await expect(emails.filter({ hasText: "New party alert" }).first()).toBeVisible();

  // The booking itself: 14 children, birthday child, paid.
  await page.goto(`/admin/bookings?q=${reference}`);
  await page.getByRole("link", { name: new RegExp(reference) }).first().click();
  await page.waitForURL(/\/admin\/bookings\/[0-9a-f-]{36}/);
  await expect(page.getByText("14 children")).toBeVisible();
  await expect(page.getByText(/Birthday child:\s*Maya, turning 8/)).toBeVisible();
  await expect(page.locator("div:has(> dt:text-is('Paid')) > dd")).toHaveText("£314.00");
});

test("the party blocks the workshops it overlaps on /book", async ({ page, request }) => {
  expect(partyStart, "the party test must run first").not.toBe("");
  const workshops = await getService(request, SW, "classic-workshops");
  const during = await sessionAt(request, SW, workshops.id, partyDay, partyStart);
  expect(during.bookable).toBe(false);
  expect(during.reason).toBe("room_busy");

  await startOnBook(page, /Classic Workshops/);
  await pickDayOnBook(page, partyDay);
  await expect(page.getByRole("heading", { name: "What time?" })).toBeVisible();

  const hour = (t: string, n: number) => `${String(Number(t.slice(0, 2)) + n).padStart(2, "0")}:${t.slice(3)}`;
  // Sessions starting inside the two-hour party are not offered.
  for (const t of [partyStart, hour(partyStart, 1)]) {
    const btn = page.getByRole("button", { name: new RegExp(`^${t}`) });
    await expect(btn).toBeDisabled();
    await expect(btn).toContainText("Not available");
  }
  // The session that starts as the party ends is free (half-open overlap).
  const after = page.getByRole("button", { name: new RegExp(`^${partyEnd}`) });
  await expect(after).toBeEnabled();
  await expect(after).toContainText(/\d+ left/);
});

test("a party cannot be started over a workshop session that has a booking", async ({ page, request }) => {
  expect(partyEnd, "the party test must run first").not.toBe("");
  const workshops = await getService(request, SW, "classic-workshops");
  const party = await getService(request, SW, "slime-party");
  const sessionTime = "15:00";
  const session = await sessionAt(request, SW, workshops.id, partyDay, sessionTime);
  expect(session.bookable).toBe(true);

  // Before: a 90-minute party at 14:00 (over the empty 15:00 session) is offered.
  const slotsBefore = await request.get(`/api/v1/venues/${SW}/availability?service=${party.id}&from=${partyDay}&to=${partyDay}`);
  const startsBefore = ((await slotsBefore.json()) as { days: { starts: { startsAt: string }[] }[] }).days.flatMap((d) => d.starts);
  expect(startsBefore.map((s) => londonTime(s.startsAt))).toContain("14:00");

  // The owner books one place in the 15:00 workshop through the new booking wizard.
  await signIn(page);
  await page.goto("/admin/bookings/new");
  await page.getByRole("listitem").getByRole("link", { name: "South Woodford" }).click();
  await page.getByRole("listitem").getByRole("link", { name: /Classic Workshops/ }).click();
  await expect(page.getByText("Which session?")).toBeVisible();
  await page.goto(withDate(page.url(), partyDay));
  await page.getByRole("link", { name: /15:00–16:00/ }).click();
  await page.getByRole("button", { name: /^More: Slime Workshop/ }).click();
  await page.getByLabel("First name").fill("Conflict");
  await page.getByLabel("Last name").fill("Check");
  await page.getByLabel("No email (walk-in)").check();
  await page.getByRole("button", { name: "Create booking" }).click();
  await page.waitForURL(/\/admin\/bookings\/[0-9a-f-]{36}/);
  await expect(page.getByText(/Booking BP-[A-Z0-9]+ made/).first()).toBeVisible();
  await expect(page.getByText(formatDay(partyDay)).first()).toBeVisible();
  await expect(page.getByText("15:00–16:00")).toBeVisible();

  // /book: party times that overlap 15:00–16:00 are gone; times either side stay.
  await startOnBook(page, /Slime Party/);
  await pickDayOnBook(page, partyDay);
  await page.getByRole("button", { name: "Continue to times" }).click();
  await expect(page.getByRole("heading", { name: "What time?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "13:30 to 15:00" })).toBeVisible();
  await expect(page.getByRole("button", { name: "16:00 to 17:30" })).toBeVisible();
  for (const t of ["14:00", "14:30", "15:00", "15:30"]) {
    await expect(page.getByRole("button", { name: new RegExp(`^${t} to `) })).toHaveCount(0);
  }

  // And the API refuses a hold for a party at 14:00 outright.
  const startsAt = new Date(new Date(session.startsAt).getTime() - 60 * 60_000).toISOString();
  expect(londonTime(startsAt)).toBe("14:00");
  const hold = await postHold(
    request,
    { venue: SW, service: party.id, startsAt, lines: [{ optionId: party.options[0].id, qty: 1 }], addOns: [] },
    fakeIp(),
  );
  expect(hold.status).toBe(409);
  expect(hold.body.error?.code).toBe("GONE");
});
