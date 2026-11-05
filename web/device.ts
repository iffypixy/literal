/** A finger, not a mouse, as `(pointer: coarse)` means in the CSS. Read live, since a tablet can gain a mouse. */
export const touch = matchMedia("(pointer: coarse)");
export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
/** Opened from the Home Screen, or as an app on a computer, rather than in a browser tab. */
export const installed = matchMedia("(display-mode: standalone)");
/** Narrow enough for the palette to be a sheet from the bottom, as palette.css draws it. */
export const sheet = matchMedia("(max-width: 640px)");

/** A Mac, iPhone or iPad, which use ⌘ rather than Ctrl. */
export const Apple = /Mac|iPhone|iPad/.test(navigator.userAgent);
/** Safari, outside the Home Screen, erases a site's storage after 7 days without a visit. */
export const Fragile = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent) && !installed.matches;

/**
 * Whether there's surely a keyboard to type with: on a computer, or when a key did it (an iPad's). Only then does a
 * field take the cursor, so a tap on a phone doesn't pop the keyboard up over the page. A click or tap is assumed
 * unless `pointer` says otherwise.
 */
export function hasKeyboard(pointer = true): boolean {
  return !pointer || !touch.matches;
}

/** Whether a mouse or finger clicked, rather than a key pressing a focused button, which counts no clicks. */
export function byPointer(event: MouseEvent): boolean {
  return event.detail > 0;
}
