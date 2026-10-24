import { expect, test, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { LOG } from "./server.ts";

/** Two devices, signed in to one account, each with a note written before signing in. */
async function devices(browser: Browser): Promise<[Page, Page]> {
  const email = `test+${Date.now()}@example.com`;
  const pages: Page[] = [];
  for (const first of ["Written on A", "Written on B"]) {
    const page = await (await browser.newContext()).newPage();
    await page.goto("/");
    await page.keyboard.type(`${first}\nbefore signing in`);
    await page.keyboard.press("Control+k");
    await page.getByRole("button", { name: /Sync across devices/ }).click();
    await page.getByLabel("Email").fill(email);
    const sent = codes(email).length;
    await page.keyboard.press("Enter");
    await page.getByLabel("Code").pressSequentially(await code(email, sent));
    await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
    pages.push(page);
  }
  return pages as [Page, Page];
}

/** The code emailed after the first `sent` ones: both devices sign in with the same address. */
async function code(email: string, sent: number): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const code = codes(email)[sent];
    if (code) return code;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no code for ${email}`);
}

function codes(email: string): string[] {
  return [...readFileSync(LOG, "utf8").matchAll(/sign-in code for (\S+): (\d{6})/g)]
    .filter((match) => match[1] === email)
    .map((match) => match[2] ?? "");
}

async function open(page: Page, title: string) {
  await page.keyboard.press("Control+k");
  await page.keyboard.type(title);
  await expect(page.getByRole("option").first()).toContainText(title, { ignoreCase: true });
  await page.keyboard.press("Enter");
}

const note = (page: Page) => page.getByRole("textbox", { name: "Note" });

test("signing in merges each device's notes into the account", async ({ browser }) => {
  const [a, b] = await devices(browser);
  for (const page of [a, b]) {
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("option")).toHaveCount(2);
    await page.keyboard.press("Escape");
  }
});

test("typing on one device shows up on the other, and offline edits on both merge", async ({ browser }) => {
  const [a, b] = await devices(browser);
  await open(a, "written on a");
  await open(b, "written on a");
  await a.keyboard.press("Control+End");
  await a.keyboard.type(", live");
  await expect(note(b)).toHaveValue("Written on A\nbefore signing in, live");

  await a.context().setOffline(true);
  await b.context().setOffline(true);
  await a.keyboard.press("Control+End");
  await a.keyboard.type("\nfrom A");
  await b.keyboard.press("Control+Home");
  await b.keyboard.type("B: ");
  await a.context().setOffline(false);
  await b.context().setOffline(false);
  const merged = "B: Written on A\nbefore signing in, live\nfrom A";
  await expect(note(a)).toHaveValue(merged, { timeout: 15_000 });
  await expect(note(b)).toHaveValue(merged, { timeout: 15_000 });
});

test("a note deleted on one device comes back with words written offline on another", async ({ browser }) => {
  const [a, b] = await devices(browser);
  await open(b, "written on a");
  await b.context().setOffline(true);
  await b.keyboard.press("Control+End");
  await b.keyboard.type("\nkept writing");

  await a.keyboard.press("Control+k");
  await a.keyboard.type("written on a");
  await a.keyboard.press("End");
  await a.keyboard.press("Delete");
  // Gone, not just collapsing: a row on its way out still matches for a moment.
  await expect(a.getByRole("option").filter({ hasText: "Written on A" })).toHaveCount(0);
  await a.keyboard.press("Escape");

  await b.context().setOffline(false);
  await expect(async () => {
    await a.keyboard.press("Control+k");
    await expect(a.getByRole("option").filter({ hasText: "Written on A" })).toHaveCount(1, { timeout: 1000 });
    await a.keyboard.press("Escape");
  }).toPass({ timeout: 15_000 });
  await open(a, "written on a");
  await expect(note(a)).toHaveValue("Written on A\nbefore signing in\nkept writing");
});
