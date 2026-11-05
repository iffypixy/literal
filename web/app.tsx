import { createEffect, createSignal, onMount } from "solid-js";
import type * as Y from "yjs";
import { isNoteId } from "#protocol.ts";
import { Editor, type EditorApi } from "#web/editor/editor.tsx";
import * as notes from "#web/notes/notes.ts";
import { prepare, quoted, shorten, title } from "#web/notes/search.ts";
import { closePalette, Palette, palette, togglePalette } from "#web/palette/palette.tsx";
import { account, farewell, onSignInElsewhere, session, signedIn } from "#web/sync/account.ts";
import { startSync } from "#web/sync/sync.ts";
import { dismiss, runAction, toast, Toasts } from "#web/ui/toast.tsx";
import { Corner } from "./corner.tsx";
import { recall, remember } from "./cursors.ts";
import { touch } from "./device.ts";
import { Drop } from "./drop.tsx";
import { isOnSheet, navigate, onBack, type Step } from "./history.ts";
import { pressed, Shortcuts } from "./shortcuts.ts";
import { stayUpToDate } from "./update.ts";

const TitleShown = 60;

export function App() {
  // Set by Editor as it renders, before anything here runs.
  let editor!: EditorApi;

  const [note, setNote] = createSignal<{ id: string; text: Y.Text } | null>(null);
  /** The palette starts on it, so ⌘K and Enter go back and forth between two notes. */
  const [previous, setPrevious] = createSignal<string | null>(null);
  /** A note is on its way from disk: until it's shown, keys would land in the page being left. */
  const [opening, setOpening] = createSignal(false);
  /** Typing with a mouse at hand: the corner's buttons step aside. */
  const [typing, setTyping] = createSignal(false);
  /** A later call to `go` wins: a note that opens after it has nothing more to do. */
  let lastGo = 0;
  /** A note was just deleted, and nothing typed since: ⌘Z means the note, wherever the cursor is. */
  let undoable = false;
  /** Notes deleted under the toast now showing: one Undo brings them all back. */
  let deleted: { id: string; wasOpen: boolean }[] = [];

  const current = () => note()?.id ?? null;

  createEffect(() => {
    const id = current();
    const name = id ? shorten(title(notes.find(id)?.text ?? ""), TitleShown) : "";
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
    void notes.start().then(() => prepare(notes.list()));
    // "replace": an address that isn't a note becomes the blank page's own.
    void go(idFrom(location.pathname), "replace");
    if (account.email) startSync();
    void checkSession();
    onSignInElsewhere(startSync);
    stayUpToDate(() => palette.open);
  });

  /** Signed in, though this device doesn't remember it: its storage was cleared, or refused. */
  async function checkSession() {
    // Offline, what this device remembers stands.
    const email = await session().catch(() => null);
    if (!email || email === account.email) return;
    signedIn(email);
    startSync();
  }

  function onSignedIn(email: string) {
    startSync();
    toast(`Signed in as ${email}`);
  }

  /**
   * Shows the note `id`, or a blank page. `focus` puts the cursor in it: always with a mouse and keyboard; on a
   * phone only when a key asked for it (an iPad's keyboard), so opening a note doesn't throw the keyboard over it.
   */
  async function go(id: string | null, how: Step, focus = !touch.matches) {
    const thisGo = ++lastGo;
    setOpening(false);
    if (id !== null && id === current()) {
      if (focus) editor.focus();
      return;
    }
    if (current() !== null) setPrevious(current());
    leave();
    if (id === null) {
      // From a blank page to a blank page: a few spaces typed there don't come along.
      if (current() === null) editor.clear();
      setNote(null);
      navigate("/", how);
      editor.focus();
      return;
    }
    setOpening(true);
    const text = await notes.open(id).catch((error: unknown) => {
      console.error(error);
      return undefined;
    });
    if (thisGo !== lastGo) return;
    setOpening(false);
    if (text === undefined) {
      toast("Couldn't open this note, please try again");
      return;
    }
    if (!text) {
      toast("Note not found");
      void go(null, "replace");
      return;
    }
    setNote({ id, text });
    navigate(`/${id}`, how);
    if (focus) editor.focus(recall(id));
  }

  function leave() {
    const id = current();
    if (!id) return;
    remember(id, editor.position());
    notes.discardIfEmpty(id);
  }

  function onCreate() {
    const created = notes.create();
    setNote(created);
    navigate(`/${created.id}`, "replace");
  }

  function goBlank() {
    closePalette(false, true);
    void go(null, "push");
  }

  function onDelete(id: string) {
    // Named, so it's clear which one went: Delete acts on whichever row is highlighted.
    const name = quoted(notes.find(id)?.text ?? "");
    void notes.remove(id);
    const wasOpen = id === current();
    if (wasOpen) {
      setNote(null);
      // Under the sheet, the address is set once the sheet has stepped back to the page beneath it.
      if (!isOnSheet()) navigate("/", "replace");
    }
    // Deletes in a row share one toast, so the earlier ones keep their Undo.
    if (deleted.length) dismiss();
    deleted.push({ id, wasOpen });
    const batch = deleted;
    toast(batch.length > 1 ? `Deleted ${batch.length} notes` : name ? `Deleted "${name}"` : "Deleted", {
      action: {
        label: "Undo",
        keys: touch.matches ? undefined : Shortcuts.undo,
        run: () => {
          deleted = [];
          undoable = false;
          void Promise.all(batch.map((note) => notes.restore(note.id))).then(() => {
            // Undo puts you back where you were: in the note, if you were in it.
            const open = batch.find((note) => note.wasOpen);
            if (open && current() === null) void go(open.id, "replace");
          });
        },
      },
      onExpire: () => {
        deleted = [];
        undoable = false;
        for (const note of batch) notes.settle(note.id);
      },
    });
    // After the toast: showing it ends the last one, whose expiry clears this.
    undoable = true;
  }

  // The app lives as long as the page, and so do these listeners.

  // Captured, so right after a delete ⌘Z reaches the note before the editor's own undo does.
  addEventListener(
    "keydown",
    (event) => {
      if (!undoable || !pressed(event, Shortcuts.undo)) return;
      event.preventDefault();
      event.stopPropagation();
      undoable = false;
      runAction();
    },
    true,
  );

  addEventListener("keydown", (event) => {
    if (pressed(event, Shortcuts.notes)) {
      event.preventDefault();
      togglePalette(false);
    } else if (pressed(event, Shortcuts.new)) {
      // On a Mac, ⌥N would type a dead key (˜) into the note.
      event.preventDefault();
      goBlank();
    } else if (
      !palette.open &&
      !opening() &&
      document.activeElement === document.body &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      // Nothing has focus (after Esc, or a click on a toast that's gone): typing still lands on the page.
      editor.focus();
    }
  });

  addEventListener("input", () => (undoable = false));

  onBack((fromSheet) => {
    closePalette(true, true);
    // Back off the sheet shows the page beneath it, whose note may have been deleted meanwhile.
    if (fromSheet) navigate(current() ? `/${current()}` : "/", "replace");
    else void go(idFrom(location.pathname), "none");
  });

  addEventListener("pagehide", (event) => {
    // Kept for the Back button, the page may come back as it was, its note still on it: nothing is discarded then.
    const id = current();
    if (event.persisted && id) remember(id, editor.position());
    else leave();
    notes.rescue();
    void notes.flush();
  });

  // A phone may close a hidden page without warning: save, and keep a copy that's written at once.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    notes.rescue();
    void notes.flush();
  });

  return (
    <>
      <div class="page" inert={palette.open} onInput={() => setTyping(!touch.matches)}>
        <Editor ref={(api) => (editor = api)} text={note()?.text ?? null} readonly={opening()} onCreate={onCreate} />
      </div>

      <Corner
        current={current()}
        away={typing()}
        onReturn={() => setTyping(false)}
        onBlank={goBlank}
        focusEditor={() => editor.focus()}
      />

      <Palette
        current={current()}
        previous={previous()}
        onPick={(id, pointer) => void go(id, "push", !touch.matches || !pointer)}
        onDelete={onDelete}
        onBlank={goBlank}
        onSignedIn={onSignedIn}
        onClose={(pointer) => {
          if (!opening() && (!touch.matches || !pointer)) editor.focus();
        }}
      />

      <Toasts />
      <Drop />
    </>
  );
}

/** The note an address names, like `/7k3qx9m2da`, in either case. */
function idFrom(path: string): string | null {
  const id = path.slice(1).toLowerCase();
  return isNoteId(id) ? id : null;
}
