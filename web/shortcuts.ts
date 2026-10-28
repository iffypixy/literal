import { Mac } from "./device.ts";

/** ⌘ on a Mac, Ctrl elsewhere. */
export function mod(event: KeyboardEvent): boolean {
  return Mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * Matches by the character typed on Latin layouts (so ⌘Z is still Z on AZERTY), and by key position where it types
 * something else (Cyrillic, or ⌥ on a Mac).
 */
export function letter(event: KeyboardEvent, letter: string): boolean {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase() === letter;
  return event.code === `Key${letter.toUpperCase()}`;
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
  notes: Mac ? ["⌘", "K"] : ["Ctrl", "K"],
  new: Mac ? ["⌥", "N"] : ["Alt", "N"],
  move: ["↑", "↓"],
  open: Mac ? ["↵"] : ["Enter"],
  delete: Mac ? ["⌘", "⌫"] : ["Del"],
  undo: Mac ? ["⌘", "Z"] : ["Ctrl", "Z"],
  close: ["Esc"],
};
