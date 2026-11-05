/** ⌘K: notes and commands, and the views they lead to. On a phone, a sheet from the bottom. */

import { batch, createEffect, createSignal, Match, Switch } from "solid-js";
import { createMutable } from "solid-js/store";
import { sheet, touch } from "#web/device.ts";
import { plural } from "#web/format.ts";
import { leaveSheet, pushSheet } from "#web/history.ts";
import { unsynced } from "#web/notes/notes.ts";
import { pressed } from "#web/shortcuts.ts";
import { deleteAccount, signOut } from "#web/sync/account.ts";
import { drain, sync } from "#web/sync/sync.ts";
import { exportAll } from "#web/transfer/transfer.ts";
import { Button } from "#web/ui/button.tsx";
import { toast } from "#web/ui/toast.tsx";
import { About } from "./about.tsx";
import { Confirm } from "./confirm.tsx";
import { grab } from "./drag.ts";
import { List } from "./list.tsx";
import { KeyboardShortcuts } from "./shortcuts.tsx";
import { SignIn } from "./sign-in.tsx";
import "./palette.css";

export type View = "notes" | "sign-in" | "sign-out" | "delete" | "keys" | "about";

type Props = {
  current: string | null;
  previous: string | null;
  /** `pointer`: whether a click or tap (not a key) did it. */
  onPick: (id: string, pointer: boolean) => void;
  onDelete: (id: string) => void;
  onBlank: () => void;
  onSignedIn: (email: string) => void;
  onClose: (pointer: boolean) => void;
};

export const palette = createMutable({ open: false });

// There's one palette, and these are set as it renders, before anything uses them.
let overlay!: HTMLDivElement;
let card!: HTMLDivElement;
let host!: Props;

const [view, setView] = createSignal<View>("notes");
/** Open, or still sliding away. The list stays until it's gone. */
const [visible, setVisible] = createSignal(false);
const [waiting, setWaiting] = createSignal(0);
let focusSearch = true;
let closedByPointer = false;

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
  // Tapped open on a phone, the keyboard would cover the list, and the search field is a tap away. Opened by a key,
  // there's a keyboard to type with, even on a tablet.
  focusSearch = !(pointer && touch.matches);
  batch(() => {
    palette.open = true;
    setView(start);
    setVisible(true);
  });
  if (sheet.matches) pushSheet();
  if ((start !== "notes" || !focusSearch) && !card.contains(document.activeElement)) card.focus();
}

/** `replaced`: a note is about to take the sheet's step in history, so it stays. */
export function closePalette(pointer: boolean, replaced = false) {
  if (!palette.open) return;
  palette.open = false;
  closedByPointer = pointer;
  if (!replaced) leaveSheet();
  if (!pointer) return finish();
  overlay.dataset.closing = "";
  card.addEventListener("animationend", finish, { once: true });
}

export function Palette(props: Props) {
  host = props;

  // Esc goes back a step, out of a view, then out of the palette.
  addEventListener("keydown", (event) => {
    if (!palette.open || event.defaultPrevented || !pressed(event, "Escape")) return;
    event.preventDefault();
    if (view() !== "notes") showList();
    else closePalette(false);
  });

  // A view other than the list puts the keyboard on its heading, so it's read out and Tab goes on from there.
  createEffect(() => {
    if (!palette.open || view() === "notes" || view() === "sign-in") return;
    document.getElementById("view-title")?.focus();
  });

  /** In the list, a click leaves the cursor in the search field, so the keys go on working. */
  function keepFocus(event: MouseEvent) {
    if (view() === "notes" && event.target instanceof Element && !event.target.closest("input, a"))
      event.preventDefault();
  }

  function pick(id: string, pointer: boolean) {
    // Closed first, since the page behind takes the cursor only once the palette is off it.
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
              onDelete={props.onDelete}
              onBlank={props.onBlank}
              onView={setView}
              onClose={closePalette}
              onSignOut={() => void signOutOrAsk()}
            />
          </Match>

          <Match when={view() === "sign-in"}>
            <SignIn onBack={showList} onDone={signedIn} />
          </Match>

          <Match when={view() === "sign-out"}>
            <Confirm
              title={notSynced(waiting())}
              action="Sign out anyway"
              busy="Signing out…"
              run={signOut}
              onCancel={showList}
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
              onCancel={showList}
            >
              Your notes will be erased from Literal and this device. This can't be undone.{" "}
              <Button variant="link" onClick={exportAll}>
                Export your notes
              </Button>{" "}
              first.
            </Confirm>
          </Match>

          <Match when={view() === "keys"}>
            <KeyboardShortcuts onBack={showList} />
          </Match>

          <Match when={view() === "about"}>
            <About onBack={showList} />
          </Match>
        </Switch>
      </div>
    </div>
  );
}

/** Dragged away, it slides off from where the finger let go. */
function dismiss() {
  palette.open = false;
  closedByPointer = true;
  leaveSheet();
  card.addEventListener("transitionend", finish, { once: true });
}

function finish() {
  // Reopened while closing, so the close is off.
  if (palette.open) return;
  card.style.transform = "";
  card.style.transition = "";
  overlay.hidden = true;
  delete overlay.dataset.closing;
  setVisible(false);
  host.onClose(closedByPointer);
}

function showList() {
  focusSearch = !touch.matches;
  setView("notes");
}

function notSynced(count: number): string {
  if (!count) return "Some notes may not have synced yet";
  return `${plural(count, "note")} ${count === 1 ? "hasn't" : "haven't"} synced yet`;
}

/** Signs out at once if everything is synced, and otherwise asks first. */
async function signOutOrAsk() {
  await drain();
  setWaiting(await unsynced());
  if (waiting() || sync.problem) return setView("sign-out");
  const error = await signOut();
  if (error) toast(error);
}
