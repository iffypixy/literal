import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import { MaxLength } from "../protocol.ts";
import { Mac, mouse } from "./device.ts";
import { count, length, notes } from "./notes/notes.ts";
import { openPalette, palette, togglePalette } from "./palette/palette.tsx";
import { Shortcuts } from "./shortcuts.ts";
import { account } from "./sync/account.ts";
import { sync } from "./sync/sync.ts";
import { IconButton } from "./ui/icon.tsx";
import { Keys } from "./ui/keys.ts";
import { toast } from "./ui/toast.tsx";
import "./corner.css";

const Explanations = {
  "Can't save here": "This browser can't save notes, so copy your text before closing",
  Offline: "Notes will sync when you're back online",
  "Not synced": "Notes are saved on this device and will sync when Literal connects",
  "Too long to sync": `Notes sync up to ${MaxLength.toLocaleString()} characters, so split this one into shorter notes`,
};

type Props = {
  current: string | null;
  onNew: () => void;
  focusEditor: () => void;
};

export function Corner(props: Props) {
  /** With a mouse, the buttons step aside while you type, and come back when the mouse moves. */
  const [typing, setTyping] = createSignal(false);

  const tooLong = createMemo(() => Boolean(account.email && props.current && length(props.current) > MaxLength));
  const problem = () => (notes.failed ? "Can't save here" : sync.status || (tooLong() ? "Too long to sync" : ""));
  const calm = createMemo(() => {
    if (props.current) return "Saved";
    const live = notes.ready ? count() : 0;
    return live ? `${live.toLocaleString()} ${live === 1 ? "note" : "notes"}` : "";
  });

  addEventListener("input", (event) => {
    if (event.target instanceof Element && event.target.matches(".editor")) setTyping(mouse.matches);
  });
  addEventListener("mousemove", (event) => {
    if (typing() && (Math.abs(event.movementX) > 1 || Math.abs(event.movementY) > 1)) setTyping(false);
  });
  createEffect(
    on(
      () => palette.open,
      () => setTyping(false),
      { defer: true },
    ),
  );

  function explain() {
    const shown = problem();
    if (shown === "Sign in to sync") return openPalette(true, "sign-in");
    if (!shown && !props.current) return togglePalette(true);
    if (shown) toast(Explanations[shown]);
    else if (account.email) toast("Notes save and sync as you type");
    else
      toast("Notes save on this device as you type", {
        action: { label: "Sync", run: () => openPalette(true, "sign-in") },
      });
    // A word of explanation, then back to writing: the click shouldn't take the cursor away.
    if (mouse.matches) props.focusEditor();
  }

  return (
    <>
      <div class="corner" classList={{ away: typing() }} inert={palette.open}>
        <Show when={problem() || calm()}>
          {(label) => (
            <button class="status" classList={{ problem: Boolean(problem()) }} onClick={explain}>
              {label()}
            </button>
          )}
        </Show>
        <IconButton label="New note" icon="plus" keys={Shortcuts.new} aria-keyshortcuts="Alt+N" onClick={props.onNew} />
        <IconButton
          label="Notes"
          icon="list"
          keys={Shortcuts.notes}
          aria-keyshortcuts={Mac ? "Meta+K" : "Control+K"}
          onClick={() => togglePalette(true)}
        />
      </div>

      {/* Only on a blank page, where it covers nothing: gone with the first word. */}
      {mouse.matches && (
        <p class="hint" classList={{ gone: props.current !== null }} aria-hidden="true">
          <span>
            <Keys keys={Shortcuts.new} /> new note
          </span>
          <span>
            <Keys keys={Shortcuts.notes} /> notes
          </span>
        </p>
      )}

      {/* Said aloud, once, by a screen reader. */}
      <p class="visually-hidden" aria-live="polite">
        {problem()}
      </p>
    </>
  );
}
