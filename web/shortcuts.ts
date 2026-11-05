import { Apple } from "./device.ts";

/** Written like "Mod+Shift+Z", where Mod is ⌘ on Apple devices and Ctrl elsewhere. */
export const Shortcuts = {
  notes: "Mod+K",
  new: "Alt+N",
  delete: Apple ? "Mod+Backspace" : "Delete",
  undo: "Mod+Z",
};

const Labels: Record<string, string> = {
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ...(Apple ? { Mod: "⌘", Alt: "⌥", Shift: "⇧", Backspace: "⌫", Enter: "↵" } : { Mod: "Ctrl", Delete: "Del" }),
};

/** As this computer's keyboard labels them, so "Mod+K" is ⌘ K on a Mac and Ctrl K elsewhere. */
export function caps(keys: string): string[] {
  return keys.split("+").map((key) => Labels[key] ?? key);
}

export function aria(keys: string): string {
  return keys.replace("Mod", Apple ? "Meta" : "Control");
}

/**
 * Exactly these keys, with no other modifier held, and not while an input method (Japanese, Chinese, Korean) is
 * mid-word; Safari marks the Enter that ends a word only with keyCode 229. A letter matches by what it types on Latin
 * layouts, so ⌘Z is still Z on AZERTY, and by its position where it types something else (Cyrillic, or ⌥ on a Mac).
 */
export function pressed(event: KeyboardEvent, keys: string): boolean {
  const parts = keys.split("+");
  const key = parts.pop() ?? "";
  const mod = parts.includes("Mod");
  if (
    event.ctrlKey !== (mod && !Apple) ||
    event.metaKey !== (mod && Apple) ||
    event.altKey !== parts.includes("Alt") ||
    event.shiftKey !== parts.includes("Shift") ||
    event.isComposing ||
    event.keyCode === 229
  )
    return false;
  if (key.length > 1) return event.key === key;
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase() === key.toLowerCase();
  return event.code === `Key${key}`;
}
