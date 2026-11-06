import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { MaxLength } from "#/protocol.ts";
import { account } from "#/web/account.ts";
import { inputOf, touch, type Input } from "#/web/lib/device.ts";
import { number, plural } from "#/web/lib/format.ts";
import * as notes from "#/web/notes.ts";
import { openPalette, palette } from "#/web/palette/palette.tsx";
import { shortcuts } from "#/web/shortcuts.ts";
import { isTooLong, sync, type Problem as SyncProblem } from "#/web/sync.ts";
import { IconButton } from "#/web/ui/icon.tsx";
import { Keys } from "#/web/ui/keys.ts";
import { toast } from "#/web/ui/toast.tsx";
import "#/web/corner.css";

type Problem = "cantSave" | "tooLong" | SyncProblem;

type Props = {
  current: string | null;
  onBlank: () => void;
  /** A click on the status explained it in a toast. */
  onExplained: (input: Input) => void;
};

const Labels = {
  cantSave: "Can't save here",
  offline: "Offline",
  unreachable: "Not synced",
  signedOut: "Sign in to sync",
  tooLong: "Too long to sync",
} satisfies Record<Problem, string>;

// What a click on a problem explains. Signed out, a click signs in instead.
const Explanations = {
  cantSave: "This browser can't save notes, so copy your text before closing",
  offline: "Notes will sync when you're back online",
  unreachable: "Notes are saved on this device and will sync when Literal connects",
  tooLong: `Notes sync up to ${number(MaxLength)} characters, so split this one into shorter notes`,
} satisfies Record<Exclude<Problem, "signedOut">, string>;

export function Corner(props: Props) {
  // On a computer, the buttons fade while you type, and come back when the mouse moves.
  const [away, setAway] = createSignal(false);
  const tooLongHere = createMemo(() => Boolean(account.email && props.current && isTooLong(props.current)));
  const problem = (): Problem | null => {
    if (notes.library.failed) return "cantSave";
    return sync.problem ?? (tooLongHere() ? "tooLong" : null);
  };
  const problemLabel = () => {
    const shown = problem();
    return shown && Labels[shown];
  };
  const summary = createMemo(() => {
    if (props.current) return "Saved";
    const live = notes.library.ready ? notes.list().length : 0;
    return live ? plural(live, "note") : null;
  });

  addEventListener("input", () => !palette.open && !touch.matches && setAway(true));
  addEventListener("mousemove", (event) => {
    const moved = Math.abs(event.movementX) > 1 || Math.abs(event.movementY) > 1;
    if (away() && moved) setAway(false);
  });
  createEffect(() => palette.open && setAway(false));

  function handleStatusClick(event: MouseEvent) {
    const input = inputOf(event);
    const shown = problem();
    if (shown === "signedOut") return openPalette(input, "signIn");
    if (!shown && !props.current) return openPalette(input);

    if (shown) toast(Explanations[shown]);
    else if (account.email) toast("Notes save and sync as you type");
    else
      toast("Notes save on this device as you type", {
        action: { label: "Sync", run: () => openPalette("pointer", "signIn") },
      });
    props.onExplained(input);
  }

  return (
    <>
      <div class="corner" data-away={away() || undefined} inert={palette.open}>
        <Show when={problemLabel() ?? summary()}>
          {(label) => (
            <button class="status quiet" data-problem={problem()} onClick={handleStatusClick}>
              {label()}
            </button>
          )}
        </Show>
        <IconButton label="New note" icon="plus" keys={shortcuts.new} onClick={props.onBlank} />
        <IconButton label="Notes" icon="list" keys={shortcuts.notes} onClick={(event) => openPalette(inputOf(event))} />
      </div>

      {/* Only on a blank page, where it covers nothing. It fades with the first word. */}
      {!touch.matches && (
        <p class="hint" data-gone={Boolean(props.current) || undefined} aria-hidden="true">
          <span>
            <Keys keys={shortcuts.new} /> new note
          </span>
          <span>
            <Keys keys={shortcuts.notes} /> notes
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
