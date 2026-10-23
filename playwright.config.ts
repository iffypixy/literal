import { defineConfig, devices } from "@playwright/test";

/** End-to-end tests against the production build, with the real Worker, served locally (see e2e/server.ts). */
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/server.ts",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://localhost:5390", ...devices["Desktop Chrome"] },
});
