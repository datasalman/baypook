/**
 * The owner takes a cash walk-in with no email through the new booking wizard, adds a
 * note, adds a place (leaving £17 to collect), cancels without a refund, and the
 * audit log records each step.
 */
import { test } from "@playwright/test";
import { addDays, bookingIdFromUrl, customerHeaders, expect, formatDay, londonDate, signIn, weekdayOf, withDate } from "./helpers";

test.use(customerHeaders());
test.describe.configure({ mode: "serial", timeout: 180_000 });

// Tomorrow, or the next day South Woodford is open (it is closed on Mondays).
let day = addDays(londonDate(), 1);
if (weekdayOf(day) === 1) day = addDays(day, 1);

let bookingId = "";
let reference = "";

test("the owner books a cash walk-in with no email for tomorrow's 14:00 workshop", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/bookings/new");
  await expect(page.getByRole("heading", { name: "New booking" })).toBeVisible();
  await page.getByRole("listitem").getByRole("link", { name: "South Woodford" }).click();
  await page.getByRole("listitem").getByRole("link", { name: /Classic Workshops/ }).click();
  await expect(page.getByText("Which session?")).toBeVisible();
  // The wizard starts on today; go straight to the day.
  await page.goto(withDate(page.url(), day));
  await expect(page.getByText(formatDay(day)).first()).toBeVisible();
  await page.getByRole("link", { name: /14:00–15:00/ }).click();

  await expect(page.getByRole("heading", { name: "Places" })).toBeVisible();
  const more = page.getByRole("button", { name: /^More: Slime Workshop/ });
  await more.click();
  await more.click();
  await expect(page.getByText(/£34\.00/).first()).toBeVisible();

  await page.getByLabel("First name").fill("Walk");
  await page.getByLabel("Last name").fill("Insmith");
  await page.getByLabel("No email (walk-in)").check();
  await expect(page.getByLabel("Email", { exact: true })).toBeDisabled();
  await page.getByLabel("Paid in cash").check();
  await page.getByLabel(/^Notes/).fill("Walked in with a friend");
  await page.getByRole("button", { name: "Create booking" }).click();

  await page.waitForURL(/\/admin\/bookings\/[0-9a-f-]{36}/);
  bookingId = bookingIdFromUrl(page.url());
  const flash = page.getByText(/Booking BP-[A-Z0-9]+ made/).first();
  await expect(flash).toBeVisible();
  reference = /BP-[A-Z0-9]+/.exec((await flash.textContent()) ?? "")?.[0] ?? "";
  expect(reference).toMatch(/^BP-/);
  // No email address, so no confirmation was sent.
  await expect(flash).not.toContainText("confirmation sent");

  await expect(page.getByRole("heading", { name: reference })).toBeVisible();
  await expect(page.getByText(formatDay(day)).first()).toBeVisible();
  await expect(page.getByText("14:00–15:00")).toBeVisible();
  await expect(page.getByText("2 places")).toBeVisible();
  await expect(page.getByText("No email (walk-in)")).toBeVisible();
  await expect(page.getByText(/Booked by staff/)).toBeVisible();
  await expect(page.locator("div:has(> dt:text-is('Payment method')) > dd")).toHaveText("Cash");
  await expect(page.locator("div:has(> dt:text-is('Paid')) > dd")).toHaveText("£34.00");
  await expect(page.getByText("Payment · Cash")).toBeVisible();
  await expect(page.getByText("No emails yet.")).toBeVisible();
});

test("the owner adds a note, adds a place and cancels without a refund", async ({ page }) => {
  expect(bookingId, "the walk-in test must run first").not.toBe("");
  await signIn(page);
  await page.goto(`/admin/bookings/${bookingId}`);

  // Note.
  const notes = page.getByLabel("Internal notes");
  await expect(notes).toHaveValue("Walked in with a friend");
  await notes.fill("Walked in with a friend. Mum will collect at 15:00.");
  await page.getByRole("button", { name: "Save notes" }).click();
  await expect(page.getByLabel("Internal notes")).toHaveValue("Walked in with a friend. Mum will collect at 15:00.");

  // Three places instead of two: £17 more to collect.
  await page.getByRole("link", { name: "Change places or extras" }).click();
  await page.waitForURL(/\/change$/);
  await page.getByRole("button", { name: /^More: Slime Workshop/ }).click();
  await expect(page.getByText("To collect in store: £17.00")).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(new RegExp(`/admin/bookings/${bookingId}(\\?|$)`));
  await expect(page.getByText("3 places")).toBeVisible();
  await expect(page.getByText("To collect in store: £17.00").first()).toBeVisible();
  await expect(page.locator("div:has(> dt:text-is('Total')) > dd")).toHaveText("£51.00");

  // Cancel, keeping the money (No refund is the default; pick it anyway).
  const panel = page.locator("details").filter({ has: page.locator("summary", { hasText: "Cancel booking" }) });
  await panel.locator("summary").click();
  await panel.getByLabel(/^Reason/).fill("Changed their mind on the day");
  await panel.getByLabel("No refund").check();
  await panel.getByRole("button", { name: "Cancel booking" }).click();
  await panel.getByRole("button", { name: "Yes, cancel it" }).click();

  await expect(page.getByText(/^Cancelled .*Changed their mind on the day/)).toBeVisible();
  await expect(page.locator("div:has(> dt:text-is('Refunded')) > dd")).toHaveText("£0.00");
  await expect(page.locator("div:has(> dt:text-is('Paid')) > dd")).toHaveText("£34.00");
});

test("the audit log lists each step for the booking", async ({ page }) => {
  expect(bookingId, "the walk-in test must run first").not.toBe("");
  await signIn(page);
  await page.goto(`/admin/audit?q=${bookingId}`);
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
  const rows = page.getByRole("listitem").filter({ hasText: bookingId });
  for (const label of ["Created a booking", "Changed booking notes", "Changed places or extras", "Cancelled a booking"]) {
    await expect(rows.filter({ hasText: label }).first()).toBeVisible();
  }
  // Newest first: the cancellation is at the top.
  await expect(rows.first()).toContainText("Cancelled a booking");
  // The booking page's own history agrees.
  await page.goto(`/admin/bookings/${bookingId}`);
  await expect(page.getByRole("heading", { name: reference })).toBeVisible();
  for (const label of ["Created a booking", "Changed booking notes", "Changed places or extras", "Cancelled a booking"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
});
