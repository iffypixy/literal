/** What did something: a click or tap, or a key. */
export type Input = "pointer" | "key";

/** A finger, not a mouse, as `(pointer: coarse)` means in the CSS. Read live, since a tablet can gain a mouse. */
export const touch = matchMedia("(pointer: coarse)");
export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
/** Opened from the Home Screen, or as an app on a computer, rather than in a browser tab. */
export const installed = matchMedia("(display-mode: standalone)");

/** A Mac, iPhone or iPad, which use ⌘ rather than Ctrl. */
export const isApple = /Mac|iPhone|iPad/.test(navigator.userAgent);
/** Safari, outside the Home Screen, erases a site's storage after 7 days without a visit. */
export const storageAtRisk =
  /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent) && !installed.matches;

/** Only then does a field take the cursor, so a tap on a phone doesn't pop the keyboard up over the page. */
export function hasKeyboard(input: Input = "pointer"): boolean {
  return input === "key" || !touch.matches;
}

/** A key that presses a focused button clicks it too, but counts no clicks. */
export function inputOf(event: MouseEvent): Input {
  return event.detail > 0 ? "pointer" : "key";
}
