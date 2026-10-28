export const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);

/** ⌘ on a Mac, Ctrl elsewhere. */
export function mod(event: KeyboardEvent): boolean {
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * Matches by the character typed on Latin layouts (so ⌘Z is still Z on AZERTY), and by key position where it types
 * something else (Cyrillic, or ⌥ on a Mac).
 */
export function letter(event: KeyboardEvent, letter: string): boolean {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase() === letter;
  return event.code === `Key${letter.toUpperCase()}`;
}

/** Labeled as this computer's keyboard labels them. */
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
 * An input method mid-word (Japanese, Chinese, Korean) owns its Enter and Esc. Safari marks the Enter that ends a
 * word only with keyCode 229.
 */
export function composing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}
