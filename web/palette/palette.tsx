/** ⌘K: notes and commands, and the views they lead to. On a phone, a sheet from the bottom. */

import { batch, createSignal, Show, type JSX } from "solid-js";
import { createMutable } from "solid-js/store";
import { leaveSheet, pushSheet } from "#/web/history.ts";
import { hasKeyboard, reducedMotion, type Input } from "#/web/lib/device.ts";
import { pressed } from "#/web/lib/keyboard.ts";
import { About } from "#/web/palette/about.tsx";
import { DeleteAccount } from "#/web/palette/delete-account.tsx";
import { grab } from "#/web/palette/drag.ts";
import { KeyboardShortcuts } from "#/web/palette/keyboard-shortcuts.tsx";
import { List } from "#/web/palette/list.tsx";
import { SignIn } from "#/web/palette/sign-in.tsx";
import { SignOut } from "#/web/palette/sign-out.tsx";
import "#/web/palette/palette.css";

export type ViewName = "notes" | "signIn" | "signOut" | "deleteAccount" | "shortcuts" | "about";

type Props = {
  current: string | null;
  previous?: string;
  onPick: (id: string, input: Input) => void;
  onDelete: (id: string) => void;
  onBlank: () => void;
  onSignedIn: (email: string) => void;
  onClose: (input: Input) => void;
};

export const palette = createMutable({ open: false });

// Narrow enough to be a sheet from the bottom, as palette.css draws it.
const sheet = matchMedia("(max-width: 640px)");

// There's one palette, and these are set as it renders, before anything uses them.
let overlay!: HTMLDivElement;
let card!: HTMLDivElement;
let onClosed: Props["onClose"] = () => {};

const [view, setView] = createSignal<ViewName>("notes");
// Open, or still sliding away. What it shows stays until it's gone, and each opening starts afresh.
const [visible, setVisible] = createSignal(false);
let focusSearch = true;

export function togglePalette(input: Input) {
  if (palette.open) closePalette(input);
  else openPalette(input);
}

/** Keys open it instantly; a click or tap gets a short animation. */
export function openPalette(input: Input, start: ViewName = "notes") {
  if (palette.open) return setView(start);
  // A close still under way is called off.
  rest();
  overlay.toggleAttribute("data-motion", input === "pointer");
  overlay.hidden = false;
  // Tapped open on a phone, the keyboard would cover the list, and the search field is a tap away.
  focusSearch = hasKeyboard(input);
  batch(() => {
    palette.open = true;
    setView(start);
    setVisible(true);
  });
  if (sheet.matches) pushSheet();
  // Whatever in it didn't take the keyboard, the card does, so keys reach the palette and not the page behind.
  if (!card.contains(document.activeElement)) card.focus();
}

export function closePalette(input: Input) {
  if (palette.open) leaveSheet();
  closePaletteForPage(input);
}

/** Leaves the sheet's step in history for the page about to open. */
export function closePaletteForPage(input: Input) {
  if (!palette.open) return;
  palette.open = false;
  if (input === "key") return finish("key");
  overlay.dataset.closing = "";
  afterCard("animationend", () => finish("pointer"));
}

export function Palette(props: Props) {
  onClosed = (input) => props.onClose(input);

  // Esc goes back a step, out of a view, then out of the palette.
  addEventListener("keydown", (event) => {
    if (!palette.open || event.defaultPrevented || !pressed(event, "Escape")) return;
    event.preventDefault();
    if (view() !== "notes") showList();
    else closePalette("key");
  });

  // In the list, a click leaves the cursor in the search field, so the keys go on working.
  function handleMouseDown(event: MouseEvent) {
    const onField = event.target instanceof Element && event.target.closest("input, a") !== null;
    if (view() === "notes" && !onField) event.preventDefault();
  }

  function handlePick(id: string, input: Input) {
    // Closed first, since the page behind takes the cursor only once the palette is off it.
    if (id === props.current) closePalette(input);
    else closePaletteForPage(input);
    props.onPick(id, input);
  }

  function handleSignedIn(email: string) {
    closePalette("pointer");
    props.onSignedIn(email);
  }

  const views = {
    notes: () => (
      <List
        current={props.current}
        previous={props.previous}
        focus={focusSearch}
        onPick={handlePick}
        onDelete={props.onDelete}
        onBlank={props.onBlank}
        onView={setView}
        onClose={closePalette}
      />
    ),
    signIn: () => <SignIn onBack={showList} onDone={handleSignedIn} />,
    signOut: () => <SignOut onCancel={showList} />,
    deleteAccount: () => <DeleteAccount onCancel={showList} />,
    shortcuts: () => <KeyboardShortcuts onBack={showList} />,
    about: () => <About onBack={showList} />,
  } satisfies Record<ViewName, () => JSX.Element>;

  return (
    <div
      ref={overlay}
      class="palette viewport"
      role="dialog"
      aria-label={view() === "notes" ? "Notes" : undefined}
      aria-labelledby={view() === "notes" ? undefined : "view-title"}
      tabindex="-1"
      hidden
    >
      <div class="scrim" aria-hidden="true" onClick={() => closePalette("pointer")} />
      <div ref={card} class="card surface" tabindex="-1" onMouseDown={handleMouseDown}>
        <button
          ref={(handle) => grab(handle, card, closeDragged)}
          class="grab"
          aria-label="Close"
          onClick={() => closePalette("pointer")}
        >
          <span />
        </button>

        <Show when={visible()}>{views[view()]()}</Show>
      </div>
    </div>
  );
}

// Dragged away, it slides off from where the finger let go.
function closeDragged() {
  palette.open = false;
  overlay.dataset.dragged = "";
  leaveSheet();
  if (reducedMotion.matches) finish("pointer");
  else afterCard("transitionend", () => finish("pointer"));
}

function finish(input: Input) {
  // Reopened while closing, so the close is off.
  if (palette.open) return;
  rest();
  overlay.hidden = true;
  setVisible(false);
  onClosed(input);
}

// Back at rest, with nothing left of a close or a drag.
function rest() {
  delete overlay.dataset.closing;
  delete overlay.dataset.dragged;
  card.style.transform = "";
  card.style.transition = "";
}

// Once the card's own animation or transition ends, not one inside it, which would bubble up to it first.
function afterCard(type: "animationend" | "transitionend", then: () => void) {
  card.addEventListener(type, function end(event) {
    if (event.target !== card) return;
    card.removeEventListener(type, end);
    then();
  });
}

function showList() {
  focusSearch = hasKeyboard();
  setView("notes");
}
