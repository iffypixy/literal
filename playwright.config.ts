import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  // A failure keeps a trace of every step, which CI uploads with the server's log.
  use: { baseURL: "http://localhost:5390", trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  // The production build with the real Worker, served locally. It sends no email, and writes codes to its log instead.
  webServer: {
    command:
      "mkdir -p test-results && wrangler d1 migrations apply literal --local --persist-to .wrangler/state && pnpm build && pnpm preview > test-results/server.log 2>&1",
    url: "http://localhost:5390",
    timeout: 180_000,
  },
});
