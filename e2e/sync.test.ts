import { readFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";

// Where the test server writes, sign-in codes included, since tests have no inbox (see playwright.config.ts).
const ServerLog = "test-results/server.log";

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

test("words composed with an input method keep their place among words arriving meanwhile", async ({ browser }) => {
  const [a, b] = await devices(browser);
  await open(a, "written on a");
  await open(b, "written on a");
  const ime = await a.context().newCDPSession(a);
  await caretAt(a, "Written".length);
  await caretAt(b, "Written ".length);

  await ime.send("Input.imeSetComposition", { text: "X", selectionStart: 1, selectionEnd: 1 });
  await b.keyboard.type("Z");
  await expect(a).toHaveTitle(/^WrittenX Zon A/);
  // Composed on past where the other device's word went in.
  await ime.send("Input.imeSetComposition", { text: "XX", selectionStart: 2, selectionEnd: 2 });
  await ime.send("Input.imeSetComposition", { text: "XXX", selectionStart: 3, selectionEnd: 3 });
  await ime.send("Input.imeSetComposition", { text: "XXXX", selectionStart: 4, selectionEnd: 4 });
  await ime.send("Input.insertText", { text: "XXXX" });

  const merged = "WrittenXXXX Zon A\nbefore signing in";
  await expect(note(a)).toHaveValue(merged);
  await expect(note(b)).toHaveValue(merged);
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
  // Gone, not just collapsing, since a row on its way out still matches for a moment.
  await expect(a.getByRole("option").filter({ hasText: "Written on A" })).toHaveCount(0);
  await a.keyboard.press("Escape");

  await b.context().setOffline(false);
  await expectListed(a, 1, "Written on A");
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
  // Sent after the words would have been, on the same connection, so once B has it, B would have them too.
  await a.keyboard.press("Alt+n");
  await a.keyboard.type("Marker");
  await expectListed(b, 1, "Marker");
  await expect(note(b)).toHaveValue("Written on A\nbefore signing in");
  await open(a, "a: written on a");

  await note(a).evaluate(
    (area: HTMLTextAreaElement, length) => area.setSelectionRange(area.value.length - length, area.value.length),
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
  await expectListed(c, 3);
});

test("words typed in a tab that can't connect reach the account through another tab", async ({ browser }) => {
  const [a, b] = await devices(browser);
  // The first reload catches A up past B's note. After the second, A has B's note only as a row in its list.
  await a.reload();
  await expectListed(a, 1, "Written on B");
  await a.reload();
  const cut = await a.context().newPage();
  await cut.routeWebSocket(/\/sync$/, (ws) => ws.close());
  await cut.goto("/");
  await open(cut, "written on b");
  await cut.keyboard.press("Control+End");
  await cut.keyboard.type(" milk");
  // Saved, so the other tab finds the words.
  await a.keyboard.press("Control+k");
  await a.keyboard.type("milk");
  await expect(a.getByRole("option").first()).toContainText("milk");
  await a.keyboard.press("Escape");

  // So it reads the note from disk, with the words the cut tab couldn't send.
  await open(a, "written on b");
  await expect(note(a)).toHaveValue("Written on B\nbefore signing in milk");
  await a.keyboard.press("Control+End");
  await a.keyboard.type(" eggs");
  await cut.close();

  await expect(note(b)).toHaveValue("Written on B\nbefore signing in milk eggs", { timeout: 15_000 });
});

test("a tab opened signed out syncs once another tab signs in", async ({ browser }) => {
  const email = address();
  const a = await device(browser, email, "Written on A");
  const context = await browser.newContext();
  const first = await context.newPage();
  await first.goto("/");
  const second = await context.newPage();
  await second.goto("/");
  await second.keyboard.press("Control+k");
  await second.getByRole("button", { name: /Sync across devices/ }).click();
  await signIn(second, email);

  await first.keyboard.type("Written in the first tab");
  await expectListed(a, 1, "Written in the first tab");
});

test("signing out with every word synced doesn't ask", async ({ browser }) => {
  const page = await device(browser, address(), "Written here");

  await page.keyboard.press("Control+k");
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();

  await expect(page.getByText("Signed out. Your notes are still in your account.")).toBeVisible();
});

test("signing out with words the server hasn't taken asks first", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+k");
  await page.getByRole("button", { name: /Sync across devices/ }).click();
  await signIn(page, address());
  // Back signed in, but with no connection, so what's typed next can't reach the server.
  await page.routeWebSocket(/\/sync$/, (ws) => ws.close());
  await page.reload();
  await page.keyboard.type("Unsent");
  await page.keyboard.press("Control+k");
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("1 note hasn't synced yet")).toBeVisible();
});

test("a device that can't erase its notes still deletes the account, and keeps them", async ({ browser }) => {
  const page = await device(browser, address(), "Written here");
  await page.evaluate(() => {
    IDBFactory.prototype.deleteDatabase = () => {
      throw new DOMException("Can't delete", "UnknownError");
    };
  });

  await page.keyboard.press("Control+k");
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("button", { name: "Delete account" }).click();
  await page.getByRole("button", { name: "Delete account" }).click();

  await expect(page.getByText("Account deleted. This device couldn't erase its notes.")).toBeVisible();
  await expectListed(page, 1, "Written here");
});

test("an address typed in capitals is the account's own once signed in", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const email = address();
  await page.goto("/");
  await page.keyboard.press("Control+k");
  await page.getByRole("button", { name: /Sync across devices/ }).click();

  await signIn(page, email, email.toUpperCase());
  await page.keyboard.press("Control+k");

  await expect(page.getByText(email, { exact: true })).toBeVisible();
});

test("going back while a code is resent stays on the email", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.clock.install();
  await page.goto("/");
  await page.keyboard.press("Control+k");
  await page.getByRole("button", { name: /Sync across devices/ }).click();
  await page.getByLabel("Email").fill(address());
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Code")).toBeVisible();
  await page.clock.runFor("00:31");
  const resend = page.waitForRequest("**/email-otp/send-verification-otp");
  let answer = () => {};
  await page.route("**/email-otp/send-verification-otp", (route) => (answer = () => void route.continue()));

  await page.getByRole("button", { name: "Resend code" }).click();
  await resend;
  await page.getByRole("button", { name: "Use another email" }).click();
  answer();

  await expect(page.getByRole("button", { name: "Send code" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
});

// Two devices, signed in to one account, each with a note written before signing in.
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

// Signs in from the sign-in view, with the code the server would have emailed, typing the address as `typed`.
async function signIn(page: Page, email: string, typed = email) {
  const sent = codes(email).length;
  await page.getByLabel("Email").fill(typed);
  await page.keyboard.press("Enter");
  await expect.poll(() => codes(email).length).toBeGreaterThan(sent);
  const code = codes(email)[sent];
  if (!code) throw new Error(`no code for ${email}`);
  await page.getByLabel("Code").pressSequentially(code);
  await expect(page.getByText(`Signed in as ${typed}`)).toBeVisible();
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
  // Until the note shows, the page is read-only and drops whatever is typed.
  await expect(page).toHaveTitle(new RegExp(`^${title}`, "i"));
}

// Opens the list until it shows `count` notes (with `text`, if given), since another device's take a while. The list
// follows changes as they arrive, so it's opened once and watched.
async function expectListed(page: Page, count: number, text?: string) {
  await page.keyboard.press("Control+k");
  const rows = page.getByRole("option");
  await expect(text ? rows.filter({ hasText: text }) : rows).toHaveCount(count, { timeout: 15_000 });
  await page.keyboard.press("Escape");
}

async function caretAt(page: Page, index: number) {
  await note(page).evaluate((area: HTMLTextAreaElement, at) => area.setSelectionRange(at, at), index);
}

function note(page: Page) {
  return page.getByRole("textbox", { name: "Note" });
}
