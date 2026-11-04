import { Apple } from "./device.ts";

/** ⌘ on Apple devices, Ctrl elsewhere. */
export function mod(event: KeyboardEvent): boolean {
  return Apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * Matches by the character typed on Latin layouts (so ⌘Z is still Z on AZERTY), and by key position where it types
 * something else (Cyrillic, or ⌥ on a Mac).
 */
export function letter(event: KeyboardEvent, key: string): boolean {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase() === key;
  return event.code === `Key${key.toUpperCase()}`;
}

/**
 * An input method mid-word (Japanese, Chinese, Korean) owns its Enter and Esc. Safari marks the Enter that ends a
 * word only with keyCode 229.
 */
export function composing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** Labeled as this computer's keyboard labels them. */
export const Shortcuts = {
  notes: Apple ? ["⌘", "K"] : ["Ctrl", "K"],
  new: Apple ? ["⌥", "N"] : ["Alt", "N"],
  move: ["↑", "↓"],
  open: Apple ? ["↵"] : ["Enter"],
  delete: Apple ? ["⌘", "⌫"] : ["Del"],
  undo: Apple ? ["⌘", "Z"] : ["Ctrl", "Z"],
  close: ["Esc"],
};
