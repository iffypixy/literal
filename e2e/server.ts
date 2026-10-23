import { execSync, spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";

/** Where the server writes its output; sign-in codes land here, since tests have no inbox. */
export const LOG = "test-results/server.log";

/** Builds the app, readies the local database, and serves the build for the tests; returns the teardown. */
export default async function setup() {
  execSync("pnpm build", { stdio: "inherit" });
  execSync("wrangler d1 migrations apply blank --local --persist-to .wrangler/state", { stdio: "inherit" });
  mkdirSync("test-results", { recursive: true });
  const out = openSync(LOG, "w");
  const server = spawn("pnpm", ["preview"], { stdio: ["ignore", out, out], detached: true });
  for (let i = 0; i < 60; i++) {
    if (
      await fetch("http://localhost:5390/").then(
        (response) => response.ok,
        () => false,
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return () => process.kill(-(server.pid ?? 0));
}
