/**
 * Demo-mode smoke test: a customer books and pays on /book, then the owner
 * refunds the booking in the admin. Runs against `npm run demo` (see
 * playwright.config.ts); wipe `.data/e2e` first for a fresh seed.
 */
import { expect as baseExpect, test, type Page } from "@playwright/test";

// `npm run demo` is a dev server: the first visit to each page compiles it, so be patient.
const expect = baseExpect.configure({ timeout: 30_000 });

test.describe.configure({ mode: "serial", timeout: 240_000 });

let reference = "";

async function signInAsOwner(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in as owner" }).click();
  await page.waitForURL(/\/admin/);
}

test("a parent books two children into a workshop and pays", async ({ page }) => {
  await page.goto("/book");

  await expect(page.getByRole("heading", { name: "Where would you like to come?" })).toBeVisible();
  await page.getByRole("button", { name: /South Woodford/ }).click();

  await expect(page.getByRole("heading", { name: "What are you booking?" })).toBeVisible();
  await page.getByRole("button", { name: /Classic Workshops/ }).click();

  // The day step preselects the first bookable day.
  await expect(page.getByRole("heading", { name: "Which day?" })).toBeVisible();
  const continueDay = page.getByRole("button", { name: /^Continue with / });
  await expect(continueDay).toBeEnabled({ timeout: 30_000 });
  await continueDay.click();

  await expect(page.getByRole("heading", { name: "What time?" })).toBeVisible();
  await page
    .getByRole("button", { name: /\d{2}:\d{2}.*\d+ left/ })
    .first()
    .click();

  await expect(page.getByRole("heading", { name: "How many places?" })).toBeVisible();
  const more = page.getByRole("button", { name: /^One more: Slime Workshop/ });
  await more.click();
  await more.click();
  await expect(page.getByText("£34").first()).toBeVisible();
  const cont = page.getByRole("button", { name: "Continue", exact: true });
  await expect(cont).toBeEnabled();
  await cont.click();

  // Details: the hold is in place and the countdown shows.
  await expect(page.getByText(/holding your places/i).first()).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("First name").fill("Amina");
  await page.getByLabel("Last name").fill("Khan");
  await page.getByLabel("Email").fill("amina.e2e@example.com");
  await page.getByLabel("Phone").fill("07700 900123");
  await page.getByLabel(/I agree to the/).check();
  await page.getByLabel(/liability waiver/).check();
  await page.getByRole("button", { name: "Pay £34" }).click();

  // The demo checkout stands in for Stripe.
  await page.waitForURL(/\/demo\/checkout\//);
  const title = page.getByRole("heading", { name: /^Pay for booking BP-/ });
  await expect(title).toBeVisible();
  reference = ((await title.textContent()) ?? "").replace("Pay for booking", "").trim();
  expect(reference).toMatch(/^BP-[A-Z0-9]+$/);
  await page.getByRole("button", { name: "Pay £34" }).click();

  // Back on the thank-you page, which polls the summary until the booking is confirmed.
  await page.waitForURL(/\/book\/thanks\?.*paid=1/);
  await expect(page.getByRole("heading", { name: "You're booked in" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(reference)).toBeVisible();
  await expect(page.getByText(/emailed you a confirmation/)).toBeVisible();
});

test("the owner finds the booking and gives a full refund", async ({ page }) => {
  expect(reference, "the booking test must run first").not.toBe("");
  await signInAsOwner(page);

  await page.goto("/admin/bookings");
  const search = page.getByRole("searchbox").or(page.getByLabel(/search/i)).first();
  await search.fill(reference);
  await search.press("Enter");
  await page.getByRole("link", { name: new RegExp(reference) }).first().click();
  await page.waitForURL(/\/admin\/bookings\/[0-9a-f-]{36}/);
  await expect(page.getByText(reference).first()).toBeVisible();

  // "Give a refund" opens a small form; the amount defaults to everything paid.
  await page.locator("summary", { hasText: "Give a refund" }).click();
  await expect(page.getByLabel(/^Amount/)).toHaveValue(/^34(\.00)?$/);
  await page.getByLabel(/^Reason/).first().fill("Smoke test refund");
  await page.getByRole("button", { name: "Give the refund" }).click();
  await page.getByRole("button", { name: "Yes, give the refund" }).click();

  // The money ledger shows the full amount refunded.
  await expect(page.locator("div:has(> dt:text-is('Refunded')) > dd")).toHaveText("£34.00", { timeout: 30_000 });
  await expect(page.locator("div:has(> dt:text-is('Paid')) > dd")).toHaveText("£34.00");

  // The refund email is in the Outbox.
  await page.goto("/admin/outbox");
  const refundEmail = page.getByRole("listitem").filter({ hasText: "Refund" }).filter({ hasText: reference });
  await expect(refundEmail.first()).toBeVisible();
});
