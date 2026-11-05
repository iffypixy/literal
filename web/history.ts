/**
 * The page's address, and its steps in history. On a phone the palette is a sheet with a step of its own, so that
 * Back closes it, and a note picked from the sheet takes that step's place.
 */

/** As a new step, in place of the current one, or not at all (Back already moved). */
export type Step = "push" | "replace" | "none";

/** Whether the sheet's step is the current one. */
let onSheet = false;

export function isOnSheet(): boolean {
  return onSheet;
}

export function pushSheet() {
  if (onSheet) return;
  history.pushState(null, "");
  onSheet = true;
}

/** Steps back off the sheet, which `onBack` then hears. */
export function leaveSheet() {
  if (onSheet) history.back();
}

export function navigate(path: string, how: Step) {
  if (how === "none") return;
  const fromSheet = onSheet;
  onSheet = false;
  if (location.pathname === path && !fromSheet) return;
  if (how === "push" && !fromSheet) history.pushState(null, "", path);
  else history.replaceState(null, "", path);
}

/** On Back or Forward, with whether it left the sheet. */
export function onBack(listener: (fromSheet: boolean) => void) {
  addEventListener("popstate", () => {
    const fromSheet = onSheet;
    onSheet = false;
    listener(fromSheet);
  });
}
