import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  use: { baseURL: "http://localhost:5390", ...devices["Desktop Chrome"] },
  // The production build with the real Worker, served locally. It sends no email: codes go to its log instead.
  webServer: {
    command:
      "mkdir -p test-results && wrangler d1 migrations apply literal --local --persist-to .wrangler/state && pnpm build && pnpm preview > test-results/server.log 2>&1",
    url: "http://localhost:5390",
    timeout: 180_000,
  },
});
