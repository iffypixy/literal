// Read live: a tablet can gain a mouse.
export const mouse = matchMedia("(hover: hover) and (pointer: fine)");
export const touch = matchMedia("(pointer: coarse)");
export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
/** Opened from the Home Screen, or as an app on a computer: not in a browser tab. */
export const installed = matchMedia("(display-mode: standalone)");

export const Mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
/** Safari, outside the Home Screen, erases a site's storage after 7 days without a visit. */
export const Fragile = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent) && !installed.matches;
