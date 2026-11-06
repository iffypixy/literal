import { isApple } from "#/web/lib/device.ts";

export const shortcuts = {
  notes: "Mod+K",
  new: "Alt+N",
  // Ctrl+Backspace erases a word on Windows.
  delete: isApple ? "Mod+Backspace" : "Delete",
  undo: "Mod+Z",
};
