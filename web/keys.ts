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

/** A shortcut drawn as key caps, like `Ctrl` `K`: see `.keys` and `kbd` in base.css. */
export function caps(keys: string[]): HTMLElement {
  const span = document.createElement("span");
  span.className = "keys";
  span.append(...keys.map((key) => Object.assign(document.createElement("kbd"), { textContent: key })));
  return span;
}

/**
 * Whether the key belongs to an input method mid-word (Japanese, Chinese, Korean): its Enter or Esc is the word's,
 * not the app's. Safari marks the Enter that ends one only with keyCode 229.
 */
export function composing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}
