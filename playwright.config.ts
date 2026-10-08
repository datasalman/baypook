import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  retries: 0,
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
