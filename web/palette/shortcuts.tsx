import { For } from "solid-js";
import { Shortcuts } from "#web/shortcuts.ts";
import { Keys } from "#web/ui/keys.ts";
import { View } from "./view.tsx";
import "./shortcuts.css";

const Rows: [string, string][] = [
  [Shortcuts.notes, "Notes and commands"],
  [Shortcuts.new, "New note"],
  ["ArrowUp+ArrowDown", "Choose a note"],
  ["Enter", "Open note"],
  [Shortcuts.delete, "Delete note"],
  [Shortcuts.undo, "Undo delete"],
  ["Escape", "Close"],
  // Tab types a tab in a note, so Esc first lets Tab move on, out of it.
  ["Escape+Tab", "Leave the note"],
];

export function KeyboardShortcuts(props: { onBack: () => void }) {
  return (
    <View title="Keyboard shortcuts" onBack={props.onBack}>
      <dl class="shortcuts">
        <For each={Rows}>
          {([keys, what]) => (
            <>
              <dt>
                <Keys keys={keys} />
              </dt>
              <dd>{what}</dd>
            </>
          )}
        </For>
      </dl>
    </View>
  );
}
