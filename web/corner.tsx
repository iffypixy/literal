import { createEffect, createMemo, on, Show } from "solid-js";
import { MaxLength } from "../protocol.ts";
import { Apple, mouse } from "./device.ts";
import { plural } from "./format.ts";
import { length, library, list } from "./notes/notes.ts";
import { openPalette, palette, togglePalette } from "./palette/palette.tsx";
import { Shortcuts } from "./shortcuts.ts";
import { account } from "./sync/account.ts";
import { sync, tooLong, type Problem as SyncProblem } from "./sync/sync.ts";
import { IconButton } from "./ui/icon.tsx";
import { Keys } from "./ui/keys.ts";
import { toast } from "./ui/toast.tsx";
import "./corner.css";

type Problem = "cant-save" | "too-long" | SyncProblem;

/** What the corner says about each problem, and what a click on it explains. Signed out, a click signs in instead. */
const Problems: Record<Problem, { label: string; explanation?: string }> = {
  "cant-save": {
    label: "Can't save here",
    explanation: "This browser can't save notes, so copy your text before closing",
  },
  offline: { label: "Offline", explanation: "Notes will sync when you're back online" },
  unreachable: {
    label: "Not synced",
    explanation: "Notes are saved on this device and will sync when Literal connects",
  },
  "signed-out": { label: "Sign in to sync" },
  "too-long": { label: "Too long to sync", explanation: tooLong() },
};

type Props = {
  current: string | null;
  /** With a mouse, the buttons step aside while you type, and come back when the mouse moves. */
  away: boolean;
  onReturn: () => void;
  onBlank: () => void;
  focusEditor: () => void;
};

export function Corner(props: Props) {
  const tooLongHere = createMemo(() => Boolean(account.email && props.current && length(props.current) > MaxLength));
  const problem = (): Problem | null =>
    library.failed ? "cant-save" : (sync.problem ?? (tooLongHere() ? "too-long" : null));
  const problemLabel = () => {
    const shown = problem();
    return shown ? Problems[shown].label : "";
  };
  const calm = createMemo(() => {
    if (props.current) return "Saved";
    const live = library.ready ? list().length : 0;
    return live ? plural(live, "note") : "";
  });

  addEventListener("mousemove", (event) => {
    if (props.away && (Math.abs(event.movementX) > 1 || Math.abs(event.movementY) > 1)) props.onReturn();
  });
  createEffect(on(() => palette.open, props.onReturn, { defer: true }));

  function explain() {
    const shown = problem();
    if (shown === "signed-out") return openPalette(true, "sign-in");
    if (!shown && !props.current) return togglePalette(true);
    if (shown) toast(Problems[shown].explanation ?? "");
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
      <div class="corner" classList={{ away: props.away }} inert={palette.open}>
        <Show when={problemLabel() || calm()}>
          {(label) => (
            <button class="status quiet" classList={{ problem: Boolean(problem()) }} onClick={explain}>
              {label()}
            </button>
          )}
        </Show>
        <IconButton
          label="New note"
          icon="plus"
          keys={Shortcuts.new}
          aria-keyshortcuts="Alt+N"
          onClick={props.onBlank}
        />
        <IconButton
          label="Notes"
          icon="list"
          keys={Shortcuts.notes}
          aria-keyshortcuts={Apple ? "Meta+K" : "Control+K"}
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
        {problemLabel()}
      </p>
    </>
  );
}
