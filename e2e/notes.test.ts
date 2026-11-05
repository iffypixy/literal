import { devices, expect, test, type Page } from "@playwright/test";

test("a note is saved as you type, and is there after a reload", async ({ page }) => {
  await page.goto("/");
  await expect(note(page)).toBeFocused();
  await page.keyboard.type("Groceries\neggs, milk");
  await expect(page).toHaveURL(/\/[0-9a-hjkmnp-tv-z]{10}$/);
  await page.reload();
  await expect(note(page)).toHaveValue("Groceries\neggs, milk");
});

test("Undo brings back a deleted note", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.type("First note");
  await page.keyboard.press("Alt+n");
  await page.keyboard.type("Second");
  // Delete takes the highlighted row, which starts on the note before.
  await page.keyboard.press("Control+k");
  await page.keyboard.press("Delete");
  const rows = page.getByRole("option");
  await expect(rows).toHaveCount(1);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(rows).toHaveCount(2);
});

test("after one visit, the app opens and saves with no network", async ({ page, context }) => {
  await page.goto("/");
  await page.keyboard.type("Written online");
  await page.evaluate(() => navigator.serviceWorker.ready);
  const url = page.url();
  await context.setOffline(true);
  await page.goto(url);
  await expect(note(page)).toHaveValue("Written online");
  await page.keyboard.press("Alt+n");
  await page.keyboard.type("Written offline");
  await page.reload();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("option")).toHaveCount(2);
});

test("an empty note opened right after another stays empty", async ({ page, context }) => {
  await page.goto("/");
  await page.keyboard.type("First note");
  await page.keyboard.press("Alt+n");
  await page.keyboard.type("Second");
  await expect(page).toHaveTitle("Second — Literal");
  const second = page.url();
  await page.goBack();
  await expect(note(page)).toHaveValue("First note");

  // Another tab empties the second note and stays on it, so the note exists with nothing in it.
  const other = await context.newPage();
  await other.goto(second);
  await expect(note(other)).toHaveValue("Second");
  await other.keyboard.press("Control+a");
  await other.keyboard.press("Delete");
  // Once this tab hears of it, the emptied note leaves its list.
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Escape");

  await page.goForward();
  await expect(page).toHaveURL(second);
  await expect(note(page)).toHaveValue("");
});

test.describe("on a phone", () => {
  // A Pixel 7, all but its browser (Chromium anyway), which a describe group can't set.
  const { defaultBrowserType: _, ...pixel } = devices["Pixel 7"];
  test.use(pixel);

  test("Back closes the notes, and from a note picked there goes back to the one before", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.type("First note");
    await page.getByRole("button", { name: "New note" }).tap();
    await page.keyboard.type("Second");
    await expect(page).toHaveTitle("Second — Literal");
    const second = page.url();
    const notes = page.getByRole("dialog", { name: "Notes" });

    // The sheet has a step of its own in history.
    await page.getByRole("button", { name: "Notes" }).tap();
    await page.goBack();
    await expect(notes).toBeHidden();
    await expect(page).toHaveURL(second);

    // A note picked from it takes that step's place.
    await page.getByRole("button", { name: "Notes" }).tap();
    await notes.getByRole("option").filter({ hasText: "First note" }).tap();
    await expect(note(page)).toHaveValue("First note");
    await page.goBack();
    await expect(page).toHaveURL(second);
    await expect(note(page)).toHaveValue("Second");
    await expect(notes).toBeHidden();
    // Took its place rather than adding one: one more Back is the first note.
    await page.goBack();
    await expect(note(page)).toHaveValue("First note");
  });
});

test("⌘K and Enter go back to the note before, however far down the list it is", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.type("Oldest");
  await expect(page).toHaveTitle("Oldest — Literal");
  // More than a page of newer notes.
  await page.keyboard.press("Control+k");
  const files = Array.from({ length: 60 }, (_, i) => ({
    name: `${i}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from(`Imported ${i}`),
  }));
  await page.locator("input[type=file]").setInputFiles(files);
  await expect(page.getByText("Imported 60 notes")).toBeVisible();
  await page.keyboard.type("imported 59");
  await page.keyboard.press("Enter");
  await expect(page).toHaveTitle("Imported 59 — Literal");

  await page.keyboard.press("Control+k");
  await page.keyboard.press("Enter");
  await expect(page).toHaveTitle("Oldest — Literal");
});

test("a note erased in another tab leaves a blank page here", async ({ page, context }) => {
  await page.goto("/");
  await page.keyboard.type("Short-lived");
  await expect(page).toHaveTitle("Short-lived — Literal");

  const other = await context.newPage();
  await other.goto("/");
  await other.keyboard.press("Control+k");
  await other.keyboard.press("Delete");
  await expect(other.getByText('Deleted "Short-lived"')).toBeVisible();
  // Erased once its Undo has passed.
  await expect(page).toHaveTitle("Literal", { timeout: 10_000 });
  await expect(note(page)).toHaveValue("");
});

test("words a closing page couldn't save come back, even into a note that was empty", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.type("Draft");
  await expect(page).toHaveTitle("Draft — Literal");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await expect(page).toHaveTitle("Literal");

  // The disk stops taking writes, and the page closes right after typing, before a save could land.
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
  });
  await page.keyboard.type("Kept");
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await page.reload();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("option")).toHaveText(/Kept/);
});

test("words from another tab don't move the cursor, or split an emoji", async ({ page, context }) => {
  await page.goto("/");
  await page.keyboard.type("Hello world");
  await expect(page).toHaveTitle("Hello world — Literal");

  await note(page).evaluate((area: HTMLTextAreaElement) => area.setSelectionRange(5, 5));

  const other = await context.newPage();
  await other.goto(page.url());
  const theirs = note(other);
  await expect(theirs).toHaveValue("Hello world");
  await other.keyboard.press("Control+Home");
  await other.keyboard.type("👋 Hi\n");

  await expect(note(page)).toHaveValue("👋 Hi\nHello world");
  await page.keyboard.type(",");
  await expect(note(page)).toHaveValue("👋 Hi\nHello, world");
  await expect(theirs).toHaveValue("👋 Hi\nHello, world");
});

function note(page: Page) {
  return page.getByRole("textbox", { name: "Note" });
}
