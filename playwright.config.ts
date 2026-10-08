import { defineConfig } from "@playwright/test";

// README screenshots: `SCREENSHOTS=1 npx playwright test tests/e2e/screenshots.spec.ts`.
// Without SCREENSHOTS=1 that spec is skipped, so `npm run test:e2e` runs only the tests.
const screenshots = process.env.SCREENSHOTS === "1";

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: screenshots ? [] : ["**/screenshots.spec.ts"],
  timeout: 90_000,
  retries: 0,
  // One demo server and one database: specs run one after another (the price spec
  // changes a price other specs total up), each with its own bookings.
  workers: 1,
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run demo",
    url: "http://localhost:3100/api/v1/venues",
    timeout: 180_000,
    reuseExistingServer: true,
    env: { BAYPOOK_MODE: "demo", BAYPOOK_DEMO_DIR: ".data/e2e", BAYPOOK_DEMO_SAMPLE: "0" },
  },
});
