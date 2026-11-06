import { createEffect, createSignal, onMount } from "solid-js";
import type * as Y from "yjs";
import { isNoteId } from "#/protocol.ts";
import { Corner } from "#/web/corner.tsx";
import { recall, remember } from "#/web/cursors.ts";
import { deleteNote } from "#/web/delete.ts";
import { Drop } from "#/web/drop.tsx";
import { Editor, type EditorApi } from "#/web/editor.tsx";
import { isOnSheet, leaveSheet, navigate, onBack, type Step } from "#/web/history.ts";
import { farewell } from "#/web/leave.ts";
import { hasKeyboard, type Input } from "#/web/lib/device.ts";
import { pressed, typesText } from "#/web/lib/keyboard.ts";
import * as notes from "#/web/notes.ts";
import { closePalette, closePaletteForPage, Palette, palette, togglePalette } from "#/web/palette/palette.tsx";
import { prepare, shorten, title } from "#/web/search.ts";
import { shortcuts } from "#/web/shortcuts.ts";
import { keepInSync, startSync } from "#/web/sync.ts";
import { toast, Toasts } from "#/web/ui/toast.tsx";
import { stayUpToDate } from "#/web/update.ts";

const TitleLength = 60;

export function App() {
  let editor!: EditorApi;

  const [note, setNote] = createSignal<{ id: string; text: Y.Text } | null>(null);
  // The palette starts on it, so ⌘K and Enter go back and forth between two notes.
  const [previous, setPrevious] = createSignal<string>();
  // A note is loading from disk. Until it shows, typing would go into the page being left.
  const [opening, setOpening] = createSignal(false);
  // A later call to `go` wins, so a note that loads after it is dropped.
  let lastGo = 0;

  const current = () => note()?.id ?? null;

  createEffect(() => {
    const id = current();
    const name = id ? shorten(title(notes.find(id)?.text ?? ""), TitleLength) : "";
    document.title = name ? `${name} — Literal` : "Literal";
  });

  // A note erased while open, by the server or another tab, leaves a blank page behind.
  createEffect(() => {
    const id = current();
    if (id && !notes.exists(id)) void go(null, "replace");
  });

  onMount(() => {
    const said = farewell();
    if (said) toast(said);
    void startNotes();
    // Replaced, so an address that isn't a note turns into the blank page's.
    void go(idFrom(location.pathname), "replace");
    keepInSync();
    stayUpToDate(() => palette.open);
  });

  async function startNotes() {
    await notes.start();
    prepare(notes.list());
  }

  // Shows the note `id`, with the cursor in it if there's a keyboard, or a blank page, which always takes the cursor.
  async function go(id: string | null, how: Step, input: Input = "pointer") {
    const thisGo = ++lastGo;
    setOpening(false);
    if (id && id === current()) {
      if (hasKeyboard(input)) editor.focus();
      return;
    }

    const before = current();
    if (before) setPrevious(before);
    leave();

    if (!id) {
      // Going from a blank page to a new one leaves behind any spaces typed on the first.
      editor.clear();
      setNote(null);
      navigate("/", how);
      editor.focus();
      return;
    }

    setOpening(true);
    const opened = await notes.open(id);
    if (thisGo !== lastGo) return;
    setOpening(false);

    if (!opened.ok) {
      switch (opened.reason) {
        case "unreadable":
          // The sheet's step was left for this note to take, so it goes the way Back would.
          leaveSheet();
          toast("Couldn't open this note. Try again.");
          return;
        case "notFound":
          toast("Note not found");
          void go(null, "replace");
          return;
      }
    }

    setNote({ id, text: opened.text });
    navigate(`/${id}`, how);
    if (hasKeyboard(input)) editor.focus(recall(id));
  }

  function leave() {
    const id = current();
    if (!id) return;
    remember(id, editor.position());
    notes.discardIfEmpty(id);
  }

  function goBlank() {
    // The blank page takes the sheet's step in history.
    closePaletteForPage("key");
    void go(null, "push");
  }

  function handleCreate() {
    const created = notes.create();
    setNote(created);
    navigate(`/${created.id}`, "replace");
  }

  function handleDelete(id: string) {
    const wasOpen = id === current();
    if (wasOpen) {
      setNote(null);
      // On the sheet, the address changes later, once Back has left the sheet's step.
      if (!isOnSheet()) navigate("/", "replace");
    }
    // Undo puts you back where you were: in the note, if you were in it.
    void deleteNote(id, () => {
      if (wasOpen && !current()) void go(id, "replace");
    });
  }

  function handleSignedIn(email: string) {
    startSync();
    toast(`Signed in as ${email}`);
  }

  // The app lives as long as the page, and so do these listeners.

  addEventListener("keydown", (event) => {
    if (pressed(event, shortcuts.notes)) {
      event.preventDefault();
      togglePalette("key");
      return;
    }
    if (pressed(event, shortcuts.new)) {
      // On a Mac, ⌥N would type a dead key (˜) into the note.
      event.preventDefault();
      goBlank();
      return;
    }
    // With nothing focused (after Esc, or a click on a toast that's gone), typing still goes into the note.
    const unfocused = document.activeElement === document.body && !palette.open && !opening();
    if (unfocused && typesText(event)) editor.focus();
  });

  onBack((fromSheet) => {
    closePalette("pointer");
    // Back off the sheet shows the page beneath it, whose note may have been deleted meanwhile.
    if (fromSheet) navigate(current() ? `/${current()}` : "/", "replace");
    else void go(idFrom(location.pathname), "none");
  });

  addEventListener("pagehide", (event) => {
    // The browser may keep this page for Back and bring it back as it was, so its note isn't discarded.
    const id = current();
    if (event.persisted && id) remember(id, editor.position());
    else leave();
  });

  return (
    <>
      <div inert={palette.open}>
        <Editor
          ref={(api) => (editor = api)}
          text={note()?.text ?? null}
          readonly={opening()}
          onCreate={handleCreate}
        />
      </div>

      <Corner current={current()} onBlank={goBlank} onExplained={(input) => hasKeyboard(input) && editor.focus()} />

      <Palette
        current={current()}
        previous={previous()}
        onPick={(id, input) => void go(id, "push", input)}
        onDelete={handleDelete}
        onBlank={goBlank}
        onSignedIn={handleSignedIn}
        onClose={(input) => !opening() && hasKeyboard(input) && editor.focus()}
      />

      <Toasts />
      <Drop />
    </>
  );
}

// The note an address names, like `/7k3qx9m2da`, in either case.
function idFrom(path: string): string | null {
  const id = path.slice(1).toLowerCase();
  return isNoteId(id) ? id : null;
}
