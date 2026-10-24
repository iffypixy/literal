import { expect, test, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/** Where the test server writes, sign-in codes included, since tests have no inbox (see playwright.config.ts). */
const ServerLog = "test-results/server.log";

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

test("a note too long to sync stays on its device, and syncs whole once it's shorter", async ({ browser }) => {
  const [a, b] = await devices(browser);
  await open(a, "written on a");
  await open(b, "written on a");
  const long = `\n${"x".repeat(100_000)}`;
  await a.keyboard.press("Control+End");
  await a.keyboard.insertText(long);
  await expect(a.getByRole("button", { name: "Too long to sync" })).toBeVisible();
  await a.keyboard.press("Control+Home");
  await a.keyboard.type("A: ");
  // Long enough for the words to reach B, were they sent: they mustn't be.
  await a.waitForTimeout(2500);
  await expect(note(b)).toHaveValue("Written on A\nbefore signing in");

  await note(a).evaluate(
    (area: HTMLTextAreaElement, n) => area.setSelectionRange(area.value.length - n, area.value.length),
    long.length,
  );
  await a.keyboard.press("Backspace");
  await expect(a.getByRole("button", { name: "Too long to sync" })).toBeHidden();
  await expect(note(b)).toHaveValue("A: Written on A\nbefore signing in");
});

test("deleting the account on one device erases it, and another device's notes go to the next one it signs in to", async ({
  browser,
}) => {
  const email = address();
  const [a, b] = await devices(browser, email);
  await a.keyboard.press("Control+k");
  await a.getByRole("button", { name: "More" }).click();
  await a.getByRole("button", { name: "Delete account" }).click();
  await a.getByRole("button", { name: "Delete account" }).click();
  await expect(a.getByText("Account deleted")).toBeVisible();
  await a.keyboard.press("Control+k");
  await expect(a.getByText("No notes yet")).toBeVisible();

  await b.getByRole("button", { name: "Sign in to sync" }).click();
  await signIn(b, email);
  const c = await device(browser, email, "Written on C");
  await expect(async () => {
    await c.keyboard.press("Control+k");
    await expect(c.getByRole("option")).toHaveCount(3, { timeout: 1000 });
    await c.keyboard.press("Escape");
  }).toPass({ timeout: 15_000 });
});

/** Two devices, signed in to one account, each with a note written before signing in. */
async function devices(browser: Browser, email = address()): Promise<[Page, Page]> {
  return [await device(browser, email, "Written on A"), await device(browser, email, "Written on B")];
}

async function device(browser: Browser, email: string, first: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  await page.keyboard.type(`${first}\nbefore signing in`);
  await page.keyboard.press("Control+k");
  await page.getByRole("button", { name: /Sync across devices/ }).click();
  await signIn(page, email);
  return page;
}

/** Signs in from the sign-in view, with the code the server would have emailed. */
async function signIn(page: Page, email: string) {
  const sent = codes(email).length;
  await page.getByLabel("Email").fill(email);
  await page.keyboard.press("Enter");
  await expect.poll(() => codes(email).length).toBeGreaterThan(sent);
  const code = codes(email)[sent];
  if (!code) throw new Error(`no code for ${email}`);
  await page.getByLabel("Code").pressSequentially(code);
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
}

function codes(email: string): string[] {
  return [...readFileSync(ServerLog, "utf8").matchAll(/sign-in code for (\S+): (\d{6})/g)].flatMap(([, to, code]) =>
    to === email && code ? [code] : [],
  );
}

function address(): string {
  return `test+${Date.now()}@example.com`;
}

async function open(page: Page, title: string) {
  await page.keyboard.press("Control+k");
  await page.keyboard.type(title);
  await expect(page.getByRole("option").first()).toContainText(title, { ignoreCase: true });
  await page.keyboard.press("Enter");
}

function note(page: Page) {
  return page.getByRole("textbox", { name: "Note" });
}
