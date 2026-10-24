export const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);

/** ⌘ on a Mac, Ctrl elsewhere. */
export function mod(event: KeyboardEvent): boolean {
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * Whether the event is the letter key `letter`, on any layout: by the character it types on Latin layouts
 * (so ⌘Z is still Z on AZERTY), and by its position where it types something else (Cyrillic, or ⌥ on a Mac).
 */
export function letter(event: KeyboardEvent, letter: string): boolean {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase() === letter;
  return event.code === `Key${letter.toUpperCase()}`;
}

/** Each shortcut's keys, labeled as this computer's keyboard labels them; drawn as key caps wherever they show. */
export const shortcuts = {
  notes: mac ? ["⌘", "K"] : ["Ctrl", "K"],
  new: mac ? ["⌥", "N"] : ["Alt", "N"],
  move: ["↑", "↓"],
  open: mac ? ["↵"] : ["Enter"],
  delete: mac ? ["⌘", "⌫"] : ["Del"],
  undo: mac ? ["⌘", "Z"] : ["Ctrl", "Z"],
  close: ["Esc"],
};
