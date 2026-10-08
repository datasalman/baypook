/**
 * Lakeside staff see only Lakeside: the bookings list, a South Woodford booking's URL,
 * and the owner-only Settings page.
 */
import { test } from "@playwright/test";
import {
  addDays,
  bookWorkshopViaApi,
  customerHeaders,
  expect,
  firstBookableSession,
  getService,
  LAKESIDE,
  londonDate,
  option,
  signIn,
  SW,
} from "./helpers";

test.use(customerHeaders());
test.describe.configure({ mode: "serial", timeout: 180_000 });

test("Lakeside staff only see Lakeside bookings", async ({ page, request }) => {
  // One paid booking at each venue, made by parents through the public API.
  const from = addDays(londonDate(), 10);
  const swWorkshops = await getService(request, SW, "classic-workshops");
  const lkWorkshops = await getService(request, LAKESIDE, "classic-workshops");
  const swSlot = await firstBookableSession(request, SW, swWorkshops.id, from, 1);
  const lkSlot = await firstBookableSession(request, LAKESIDE, lkWorkshops.id, from, 1);
  const sw = await bookWorkshopViaApi(page, {
    venue: SW,
    serviceId: swWorkshops.id,
    sessionId: swSlot.session.id,
    lines: [{ optionId: option(swWorkshops, "Slime Workshop").id, qty: 1 }],
    firstName: "Sofia",
    lastName: "Woodford",
    email: "sofia.sw.e2e@example.com",
  });
  const lk = await bookWorkshopViaApi(page, {
    venue: LAKESIDE,
    serviceId: lkWorkshops.id,
    sessionId: lkSlot.session.id,
    lines: [{ optionId: option(lkWorkshops, "Slime Workshop").id, qty: 1 }],
    firstName: "Leo",
    lastName: "Lakeside",
    email: "leo.lk.e2e@example.com",
  });

  await signIn(page, "Sign in as Lakeside staff");

  // The list is Lakeside's: the Lakeside booking is found, the South Woodford one is not.
  await page.goto("/admin/bookings");
  await expect(page.getByRole("heading", { name: "Bookings" })).toBeVisible();
  await expect(page.getByText("All venues")).toHaveCount(0);
  await page.goto(`/admin/bookings?q=${lk.reference}`);
  await expect(page.getByRole("link", { name: new RegExp(lk.reference) }).first()).toBeVisible();
  await page.goto(`/admin/bookings?q=${sw.reference}`);
  await expect(page.getByText("No bookings found")).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(sw.reference) })).toHaveCount(0);
  await page.goto("/admin/bookings?q=e2e%40example.com");
  await expect(page.getByText(/South Woodford/)).toHaveCount(0);

  // Opening the South Woodford booking directly is refused.
  await page.goto(`/admin/bookings/${sw.bookingId}`);
  await expect(page).toHaveURL(/\/admin\/bookings(\?|$)/);
  await expect(page.getByText(/belongs to another venue/)).toBeVisible();
  await expect(page.getByText(sw.reference)).toHaveCount(0);

  // Their own booking opens, without a refund button (staff cannot refund).
  await page.goto(`/admin/bookings/${lk.bookingId}`);
  await expect(page.getByRole("heading", { name: lk.reference })).toBeVisible();
  await expect(page.locator("summary", { hasText: "Give a refund" })).toHaveCount(0);

  // Settings are for the owner.
  await page.goto("/admin/settings");
  await expect(page.getByText("Only the owner can change settings")).toBeVisible();
});
