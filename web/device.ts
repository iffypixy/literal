/** A finger, not a mouse: like `(pointer: coarse)` in the CSS. Read live, since a tablet can gain a mouse. */
export const touch = matchMedia("(pointer: coarse)");
export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
/** Opened from the Home Screen, or as an app on a computer: not in a browser tab. */
export const installed = matchMedia("(display-mode: standalone)");
/** Narrow enough for the palette to be a sheet from the bottom, as palette.css draws it. */
export const sheet = matchMedia("(max-width: 640px)");

/** A Mac, iPhone or iPad: ⌘ rather than Ctrl. */
export const Apple = /Mac|iPhone|iPad/.test(navigator.userAgent);
/** Safari, outside the Home Screen, erases a site's storage after 7 days without a visit. */
export const Fragile = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent) && !installed.matches;
