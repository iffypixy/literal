import { createEffect, createMemo, createSignal, Show } from "solid-js";
import * as notes from "#web/notes/notes.ts";
import { openPalette, palette } from "#web/palette/palette.tsx";
import { account } from "#web/sync/account.ts";
import { isTooLong, sync, tooLong, type Problem as SyncProblem } from "#web/sync/sync.ts";
import { IconButton } from "#web/ui/icon.tsx";
import { Keys } from "#web/ui/keys.ts";
import { toast } from "#web/ui/toast.tsx";
import { byPointer, hasKeyboard, touch } from "./device.ts";
import { plural } from "./format.ts";
import { Shortcuts } from "./shortcuts.ts";
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
  onBlank: () => void;
  focusEditor: () => void;
};

export function Corner(props: Props) {
  /** On a computer, the buttons fade while you type, and come back when the mouse moves. */
  const [away, setAway] = createSignal(false);
  const tooLongHere = createMemo(() => Boolean(account.email && props.current && isTooLong(props.current)));
  const problem = (): Problem | null =>
    notes.library.failed ? "cant-save" : (sync.problem ?? (tooLongHere() ? "too-long" : null));
  const problemLabel = () => {
    const shown = problem();
    return shown ? Problems[shown].label : "";
  };
  const summary = createMemo(() => {
    if (props.current) return "Saved";
    const live = notes.library.ready ? notes.list().length : 0;
    return live ? plural(live, "note") : "";
  });

  addEventListener("input", () => !palette.open && !touch.matches && setAway(true));
  addEventListener("mousemove", (event) => {
    if (away() && (Math.abs(event.movementX) > 1 || Math.abs(event.movementY) > 1)) setAway(false);
  });
  createEffect(() => palette.open && setAway(false));

  function explain(event: MouseEvent) {
    const pointer = byPointer(event);
    const shown = problem();
    if (shown === "signed-out") return openPalette(pointer, "sign-in");
    if (!shown && !props.current) return openPalette(pointer);
    if (shown) toast(Problems[shown].explanation ?? "");
    else if (account.email) toast("Notes save and sync as you type");
    else
      toast("Notes save on this device as you type", {
        action: { label: "Sync", run: () => openPalette(true, "sign-in") },
      });
    // Explain, then go back to writing. The click shouldn't take the cursor away.
    if (hasKeyboard(pointer)) props.focusEditor();
  }

  return (
    <>
      <div class="corner" classList={{ away: away() }} inert={palette.open}>
        <Show when={problemLabel() || summary()}>
          {(label) => (
            <button class="status quiet" classList={{ problem: Boolean(problem()) }} onClick={explain}>
              {label()}
            </button>
          )}
        </Show>
        <IconButton label="New note" icon="plus" keys={Shortcuts.new} onClick={props.onBlank} />
        <IconButton
          label="Notes"
          icon="list"
          keys={Shortcuts.notes}
          onClick={(event) => openPalette(byPointer(event))}
        />
      </div>

      {/* Only on a blank page, where it covers nothing. It fades with the first word. */}
      {!touch.matches && (
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
