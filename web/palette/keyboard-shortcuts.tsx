import { For } from "solid-js";
import { View } from "#/web/palette/view.tsx";
import { shortcuts } from "#/web/shortcuts.ts";
import { Keys } from "#/web/ui/keys.ts";
import "#/web/palette/keyboard-shortcuts.css";

const rows: [keys: string, does: string][] = [
  [shortcuts.notes, "Notes and commands"],
  [shortcuts.new, "New note"],
  ["ArrowUp+ArrowDown", "Choose a note"],
  ["Enter", "Open note"],
  [shortcuts.delete, "Delete note"],
  [shortcuts.undo, "Undo delete"],
  ["Escape", "Close"],
  // Tab types a tab in a note, so Esc first lets Tab move on, out of it.
  ["Escape+Tab", "Leave the note"],
];

export function KeyboardShortcuts(props: { onBack: () => void }) {
  return (
    <View title="Keyboard shortcuts" onBack={props.onBack}>
      <dl class="shortcuts">
        <For each={rows}>
          {([keys, does]) => (
            <>
              <dt>
                <Keys keys={keys} />
              </dt>
              <dd>{does}</dd>
            </>
          )}
        </For>
      </dl>
    </View>
  );
}
