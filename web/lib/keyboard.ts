/** Keys are written like "Mod+Shift+Z", where Mod is ⌘ on Apple devices and Ctrl elsewhere. */

import { isApple } from "#/web/lib/device.ts";

const labels: Record<string, string> = {
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ...(isApple ? { Mod: "⌘", Alt: "⌥", Shift: "⇧", Backspace: "⌫", Enter: "↵" } : { Mod: "Ctrl", Delete: "Del" }),
};

/**
 * Exactly these keys, with no other modifier held, and not while an input method (Japanese, Chinese, Korean) is
 * mid-word. A letter matches by what it types on Latin layouts, so ⌘Z is still Z on AZERTY, and by its position where
 * it types something else (Cyrillic, or ⌥ on a Mac).
 */
export function pressed(event: KeyboardEvent, keys: string): boolean {
  const parts = keys.split("+");
  const key = parts.pop() ?? "";
  const mod = parts.includes("Mod");
  const exactModifiers =
    event.ctrlKey === (mod && !isApple) &&
    event.metaKey === (mod && isApple) &&
    event.altKey === parts.includes("Alt") &&
    event.shiftKey === parts.includes("Shift");
  // Safari marks the Enter that ends a word only with keyCode 229.
  const composing = event.isComposing || event.keyCode === 229;
  if (!exactModifiers || composing) return false;

  if (key.length > 1) return event.key === key;
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase() === key.toLowerCase();
  return event.code === `Key${key}`;
}

/** A key that types a character, not a shortcut, and not a key like Enter or Tab. */
export function typesText(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/** As this computer's keyboard labels them, so "Mod+K" is ⌘ K on a Mac and Ctrl K elsewhere. */
export function caps(keys: string): string[] {
  return keys.split("+").map((key) => labels[key] ?? key);
}

/** As aria-keyshortcuts spells them, like "Meta+K". */
export function aria(keys: string): string {
  return keys.replace("Mod", isApple ? "Meta" : "Control");
}
