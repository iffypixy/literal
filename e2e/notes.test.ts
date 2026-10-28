import { expect, test } from "@playwright/test";

test("a note is saved as you type, and is there after a reload", async ({ page }) => {
  await page.goto("/");
  const note = page.getByRole("textbox", { name: "Note" });
  await expect(note).toBeFocused();
  await page.keyboard.type("Groceries\neggs, milk");
  await expect(page).toHaveURL(/\/[0-9a-hjkmnp-tv-z]{10}$/);
  await page.reload();
  await expect(note).toHaveValue("Groceries\neggs, milk");
});

test("opening the app and leaving without typing leaves no note", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.type("   ");
  await page.keyboard.press("Alt+n");
  await page.keyboard.press("Control+k");
  await expect(page.getByText("No notes yet")).toBeVisible();
});

test("search finds a note by any of its words, ignoring accents; Undo brings back a deleted one", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.type("Café list\nNewsreader, crème brûlée");
  await page.keyboard.press("Alt+n");
  await page.keyboard.type("Book list\nPiranesi");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("creme cafe");
  const rows = page.getByRole("option");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Café list");

  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Delete");
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
  await expect(page.getByRole("textbox", { name: "Note" })).toHaveValue("Written online");
  await page.keyboard.press("Alt+n");
  await page.keyboard.type("Written offline");
  await page.reload();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("option")).toHaveCount(2);
});

test("an empty note opened right after another stays empty", async ({ page, context }) => {
  const note = page.getByRole("textbox", { name: "Note" });
  await page.goto("/");
  await page.keyboard.type("First note");
  await page.keyboard.press("Alt+n");
  await page.keyboard.type("Second");
  await expect(page).toHaveTitle("Second — Literal");
  const second = page.url();
  await page.goBack();
  await expect(note).toHaveValue("First note");

  // Another tab empties the second note and stays on it: a note that exists, with nothing in it.
  const other = await context.newPage();
  await other.goto(second);
  await expect(other.getByRole("textbox", { name: "Note" })).toHaveValue("Second");
  await other.keyboard.press("Control+a");
  await other.keyboard.press("Delete");
  await expect(note).toHaveValue("First note");

  await page.goForward();
  await expect(page).toHaveURL(second);
  await expect(note).toHaveValue("");
});

test("words from another tab don't move the cursor, or split an emoji", async ({ page, context }) => {
  const note = page.getByRole("textbox", { name: "Note" });
  await page.goto("/");
  await page.keyboard.type("Hello world");
  await expect(page).toHaveTitle("Hello world — Literal");

  await note.evaluate((area: HTMLTextAreaElement) => area.setSelectionRange(5, 5));

  const other = await context.newPage();
  await other.goto(page.url());
  const theirs = other.getByRole("textbox", { name: "Note" });
  await expect(theirs).toHaveValue("Hello world");
  await other.keyboard.press("Control+Home");
  await other.keyboard.type("👋 Hi\n");

  await expect(note).toHaveValue("👋 Hi\nHello world");
  await page.keyboard.type(",");
  await expect(note).toHaveValue("👋 Hi\nHello, world");
  await expect(theirs).toHaveValue("👋 Hi\nHello, world");
});
