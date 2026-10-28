import { batch, createEffect, createSignal, For, Match, Switch } from "solid-js";
import { createMutable } from "solid-js/store";
import { touch } from "../device.ts";
import { unsynced } from "../notes/notes.ts";
import { composing, Shortcuts } from "../shortcuts.ts";
import { deleteAccount, signOut } from "../sync/account.ts";
import { drain, sync } from "../sync/sync.ts";
import { exportAll } from "../transfer/transfer.ts";
import { Button } from "../ui/button.tsx";
import { Keys } from "../ui/keys.ts";
import { toast } from "../ui/toast.tsx";
import { Back } from "./back.tsx";
import { Confirm } from "./confirm.tsx";
import { grab } from "./drag.ts";
import { List } from "./list.tsx";
import { SignIn } from "./sign-in.tsx";
import "./palette.css";

/** ⌘K: notes and commands, and the views they lead to. On a phone, a sheet from the bottom. */

export type View = "notes" | "sign-in" | "sign-out" | "delete" | "keys" | "about";

type Props = {
  current: string | null;
  previous: string | null;
  /** `pointer`: whether a click or tap (not a key) did it. */
  onPick: (id: string, pointer: boolean) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onSignedIn: (email: string) => void;
  onClose: (pointer: boolean) => void;
  /** The sheet stepped back in history to the page beneath it, whose note may have been deleted meanwhile. */
  onStepBack: () => void;
};

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

export const palette = createMutable({ open: false });

// There's one palette: these are set as it renders, before anything uses them.
let overlay!: HTMLDivElement;
let card!: HTMLDivElement;
let host!: Props;

const [view, setView] = createSignal<View>("notes");
/** Open, or still sliding away: the list stays until it's gone. */
const [visible, setVisible] = createSignal(false);
const [waiting, setWaiting] = createSignal(0);
let focusSearch = true;
let closedByPointer = false;
/** On a touch screen the sheet is a step in history, so Back closes it. True while the palette steps back itself. */
let stepping = false;

// Before App's own listener, which then never sees what's the palette's.
addEventListener("popstate", (event) => {
  if (!stepping && !palette.open) return;
  event.stopImmediatePropagation();
  if (stepping) {
    stepping = false;
    host.onStepBack();
  } else {
    closePalette(true, true);
  }
});

// Esc goes back a step: out of a view, then out of the palette.
addEventListener("keydown", (event) => {
  if (!palette.open || event.key !== "Escape" || event.defaultPrevented || composing(event)) return;
  event.preventDefault();
  if (view() !== "notes") back();
  else closePalette(false);
});

export function togglePalette(pointer: boolean) {
  if (palette.open) closePalette(pointer);
  else openPalette(pointer);
}

/** Keys open it instantly; a click or tap gets a short animation. */
export function openPalette(pointer: boolean, start: View = "notes") {
  if (palette.open) return setView(start);
  delete overlay.dataset.closing;
  overlay.toggleAttribute("data-motion", pointer);
  card.style.transform = "";
  card.style.transition = "";
  overlay.hidden = false;
  // Tapped open on a phone, the keyboard would cover the list; the search field is a tap away. Opened by a key,
  // there's a keyboard to type with, even on a tablet.
  focusSearch = !(pointer && touch.matches);
  batch(() => {
    palette.open = true;
    setView(start);
    setVisible(true);
  });
  if (touch.matches) history.pushState({ sheet: true }, "");
  if ((start !== "notes" || !focusSearch) && !card.contains(document.activeElement)) card.focus();
}

/** `opened`: a note took its place, and with it the sheet's step in history. */
export function closePalette(pointer: boolean, opened = false) {
  if (!palette.open) return;
  palette.open = false;
  closedByPointer = pointer;
  if (!opened) stepBack();
  if (!pointer) return finish();
  overlay.dataset.closing = "";
  card.addEventListener("animationend", finish, { once: true });
}

/** Whether the phone's sheet is the current step in history, where App replaces rather than adds a step. */
export function onSheet(): boolean {
  return Boolean(history.state?.sheet);
}

export function Palette(props: Props) {
  host = props;

  // A view other than the list puts the keyboard on its heading, so it's read out and Tab goes on from there.
  createEffect(() => {
    if (!palette.open || view() === "notes" || view() === "sign-in") return;
    document.getElementById("view-title")?.focus();
  });

  /** In the list, a click leaves the cursor where it was, in the search field: the keys go on working. */
  function keepFocus(event: MouseEvent) {
    if (view() === "notes" && event.target instanceof Element && !event.target.closest("input, a"))
      event.preventDefault();
  }

  function pick(id: string, pointer: boolean) {
    // Closed first: the page behind takes the cursor only once the palette is off it.
    closePalette(pointer, id !== props.current);
    props.onPick(id, pointer);
  }

  function signedIn(email: string) {
    setView("notes");
    closePalette(true);
    props.onSignedIn(email);
  }

  return (
    <div
      ref={overlay}
      class="palette"
      role="dialog"
      aria-label={view() === "notes" ? "Notes" : undefined}
      aria-labelledby={view() === "notes" ? undefined : "view-title"}
      tabindex="-1"
      hidden
    >
      <div class="scrim" aria-hidden="true" onClick={() => closePalette(true)} />
      <div ref={card} class="card surface" tabindex="-1" onMouseDown={keepFocus}>
        <button
          ref={(handle) => grab(handle, card, dismiss)}
          class="grab"
          aria-label="Close"
          onClick={() => closePalette(true)}
        >
          <span />
        </button>

        <Switch>
          <Match when={view() === "notes" && visible()}>
            <List
              current={props.current}
              previous={props.previous}
              focus={focusSearch}
              onPick={pick}
              onDelete={(id) => props.onDelete(id)}
              onNew={() => props.onNew()}
              onView={setView}
              onClose={closePalette}
              onSignOut={() => void leave()}
            />
          </Match>

          <Match when={view() === "sign-in"}>
            <SignIn onBack={back} onDone={signedIn} />
          </Match>

          <Match when={view() === "sign-out"}>
            <Confirm
              title={notSynced(waiting())}
              action="Sign out anyway"
              busy="Signing out…"
              run={signOut}
              onCancel={back}
            >
              Signing out removes notes from this device. Changes that haven't synced will be lost.
            </Confirm>
          </Match>

          <Match when={view() === "delete"}>
            <Confirm
              title="Delete your account and all your notes?"
              action="Delete account"
              busy="Deleting…"
              run={deleteAccount}
              onCancel={back}
            >
              Your notes will be erased from Literal and this device. This can't be undone.{" "}
              <Button variant="link" onClick={exportAll}>
                Export your notes
              </Button>{" "}
              first.
            </Confirm>
          </Match>

          <Match when={view() === "keys"}>
            <div class="view">
              <Back onClick={back} />
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
          </Match>

          <Match when={view() === "about"}>
            <div class="view">
              <Back onClick={back} />
              <h2 id="view-title" tabindex="-1">
                Literal
              </h2>
              <p>Instant notes, on all your devices.</p>
              <p class="section">
                Made by Ansat
                <br />
                Write to <a href="mailto:hello@literal.ink">hello@literal.ink</a>
              </p>
              <p class="section">
                <a href="/terms" target="_blank">
                  Terms
                </a>{" "}
                ·{" "}
                <a href="/privacy" target="_blank">
                  Privacy
                </a>{" "}
                ·{" "}
                <a href="https://github.com/iffypixy/literal" target="_blank">
                  Source
                </a>
              </p>
            </div>
          </Match>
        </Switch>
      </div>
    </div>
  );
}

/** Dragged away: it slides off from where the finger let go. */
function dismiss() {
  palette.open = false;
  closedByPointer = true;
  stepBack();
  card.addEventListener("transitionend", finish, { once: true });
}

function finish() {
  // Reopened while closing: the close is off.
  if (palette.open) return;
  card.style.transform = "";
  card.style.transition = "";
  overlay.hidden = true;
  delete overlay.dataset.closing;
  setVisible(false);
  host.onClose(closedByPointer);
}

function back() {
  focusSearch = !touch.matches;
  setView("notes");
}

function stepBack() {
  if (!onSheet()) return;
  stepping = true;
  history.back();
}

function notSynced(count: number): string {
  if (count === 1) return "1 note hasn't synced yet";
  if (count) return `${count.toLocaleString()} notes haven't synced yet`;
  return "Some notes may not have synced yet";
}

/** Signs out at once if everything is synced; otherwise asks first. */
async function leave() {
  await drain();
  setWaiting(unsynced());
  if (waiting() || sync.status) return setView("sign-out");
  const error = await signOut();
  if (error) toast(error);
}
