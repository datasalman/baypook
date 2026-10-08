/**
 * The owner changes the Slime Workshop price in the Catalogue and the public quote
 * follows at once. The price is put back to £17 afterwards, pass or fail.
 */
import { test, type APIRequestContext, type Page } from "@playwright/test";
import { customerHeaders, expect, getService, option, signIn, SW, type ApiService } from "./helpers";

test.use(customerHeaders());
test.describe.configure({ mode: "serial", timeout: 120_000 });

async function quoteUnit(request: APIRequestContext, svc: ApiService, optionId: string, qty: number): Promise<{ unit: number; total: number }> {
  const res = await request.post("/api/v1/quote", {
    data: { venue: SW, service: svc.id, lines: [{ optionId, qty }], addOns: [] },
  });
  expect(res.status(), await res.text()).toBe(200);
  const { quote } = (await res.json()) as { quote: { lines: { optionId: string; unitPence: number }[]; totalPence: number } };
  return { unit: quote.lines.find((l) => l.optionId === optionId)?.unitPence ?? -1, total: quote.totalPence };
}

async function setPrice(page: Page, svc: ApiService, optionId: string, pounds: string): Promise<void> {
  await page.goto(`/admin/catalogue/${svc.id}`);
  const card = page.locator("details").filter({ has: page.locator(`#opt-${optionId}-price`) });
  await card.locator("summary").first().click();
  await card.getByLabel("Price per place (£)").fill(pounds);
  await card.getByRole("button", { name: "Save Slime Workshop" }).click();
  await expect(
    page.locator("summary").filter({ hasText: "Slime Workshop" }).filter({ hasText: `£${pounds}.00 a place` }),
  ).toBeVisible();
}

test("a new Slime Workshop price reaches the public quote straight away", async ({ page, request }) => {
  const svc = await getService(request, SW, "classic-workshops");
  const slime = option(svc, "Slime Workshop");
  expect(await quoteUnit(request, svc, slime.id, 2)).toEqual({ unit: 1700, total: 3400 });

  await signIn(page);
  try {
    await setPrice(page, svc, slime.id, "18");

    expect(await quoteUnit(request, svc, slime.id, 1)).toEqual({ unit: 1800, total: 1800 });
    expect(await quoteUnit(request, svc, slime.id, 2)).toEqual({ unit: 1800, total: 3600 });
    const after = await getService(request, SW, "classic-workshops");
    expect(option(after, "Slime Workshop").unitPricePence).toBe(1800);
    // Lakeside has its own catalogue: unchanged.
    const lakeside = await getService(request, "lakeside", "classic-workshops");
    expect(option(lakeside, "Slime Workshop").unitPricePence).toBe(1700);
  } finally {
    await setPrice(page, svc, slime.id, "17");
  }
  expect(await quoteUnit(request, svc, slime.id, 1)).toEqual({ unit: 1700, total: 1700 });
});
