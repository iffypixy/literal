import { For } from "solid-js";
import { Shortcuts } from "../shortcuts.ts";
import { Keys } from "../ui/keys.ts";
import { Back } from "./back.tsx";
import "./shortcuts.css";

const KeyList: [string[], string][] = [
  [Shortcuts.notes, "Notes and commands"],
  [Shortcuts.new, "New note"],
  [Shortcuts.move, "Choose a note"],
  [Shortcuts.open, "Open note"],
  [Shortcuts.delete, "Delete note"],
  [Shortcuts.undo, "Undo delete"],
  [Shortcuts.close, "Close"],
  // Tab types a tab in a note: Esc first lets Tab move on, out of it.
  [["Esc", "Tab"], "Leave the note"],
];

export function KeyboardShortcuts(props: { onBack: () => void }) {
  return (
    <div class="view">
      <Back onClick={props.onBack} />
      <h2 id="view-title" tabindex="-1">
        Keyboard shortcuts
      </h2>
      <dl class="shortcuts">
        <For each={KeyList}>
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
    </div>
  );
}
