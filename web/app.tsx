import { createEffect, createSignal, onMount } from "solid-js";
import type * as Y from "yjs";
import { isNoteId } from "../protocol.ts";
import { Corner } from "./corner.tsx";
import { recall, remember } from "./cursors.ts";
import { mouse } from "./device.ts";
import { Drop } from "./drop.tsx";
import { Editor, type EditorApi } from "./editor/editor.tsx";
import {
  create,
  discardIfEmpty,
  exists,
  find,
  flush,
  list,
  open,
  remove,
  rescue,
  restore,
  settle,
  start,
} from "./notes/notes.ts";
import { prepare, quoted, shorten, title } from "./notes/search.ts";
import { closePalette, onSheet, Palette, palette, togglePalette } from "./palette/palette.tsx";
import { letter, mod, Shortcuts } from "./shortcuts.ts";
import { account, farewell, session, signedIn } from "./sync/account.ts";
import { start as startSync } from "./sync/sync.ts";
import { act, quiet, toast, Toasts } from "./ui/toast.tsx";
import { stayUpToDate } from "./update.ts";

const TitleShown = 60;

type How = "push" | "replace" | "none";

export function App() {
  // Set by Editor as it renders, before anything here runs.
  let editor!: EditorApi;

  const [note, setNote] = createSignal<{ id: string; text: Y.Text } | null>(null);
  /** The palette starts on it, so ⌘K and Enter go back and forth between two notes. */
  const [previous, setPrevious] = createSignal<string | null>(null);
  /** A note is on its way from disk: until it's shown, keys would land in the page being left. */
  const [opening, setOpening] = createSignal(false);
  /** A note was just deleted, and nothing typed since: ⌘Z means the note, wherever the cursor is. */
  let undoable = false;
  /** Notes deleted under the toast now showing: one Undo brings them all back. */
  let deleted: { id: string; wasOpen: boolean }[] = [];

  const current = () => note()?.id ?? null;

  createEffect(() => {
    const id = current();
    const name = id ? shorten(title(find(id)?.text ?? ""), TitleShown) : "";
    document.title = name ? `${name} — Literal` : "Literal";
  });

  // A note erased while open, by the server or another tab, leaves a blank page behind.
  createEffect(() => {
    const id = current();
    if (id && !exists(id)) void go(null, "replace");
  });

  onMount(() => {
    const said = farewell();
    if (said) toast(said);
    void start().then(() => prepare(list()));
    // "replace": an address that isn't a note becomes the blank page's own.
    void go(idFrom(location.pathname), "replace");
    if (account.email) startSync();
    void checkSession();
    stayUpToDate(() => palette.open);
  });

  /** Signed in elsewhere, e.g. in another tab since this one opened. */
  async function checkSession() {
    let email: string | null;
    try {
      email = await session();
    } catch {
      return; // offline: what this device remembers stands
    }
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
  async function go(id: string | null, how: How, focus = mouse.matches) {
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
    let text: Y.Text | null;
    try {
      text = await open(id);
    } catch (error) {
      console.error(error);
      toast("Couldn't open this note, please try again");
      return;
    } finally {
      setOpening(false);
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
    discardIfEmpty(id);
  }

  function navigate(path: string, how: How) {
    if (how === "none") return;
    // The phone's sheet is a step in history (so Back closes it): a note it opens takes that step's place.
    const sheet = onSheet();
    if (location.pathname === path && !sheet) return;
    if (how === "push" && !sheet) history.pushState(null, "", path);
    else history.replaceState(null, "", path);
  }

  function onCreate() {
    const created = create();
    setNote(created);
    navigate(`/${created.id}`, "replace");
  }

  function newNote() {
    closePalette(false, true);
    void go(null, "push");
  }

  function onDelete(id: string) {
    // Named, so it's clear which one went: Delete acts on whichever row is highlighted.
    const name = quoted(find(id)?.text ?? "");
    void remove(id);
    const wasOpen = id === current();
    if (wasOpen) {
      setNote(null);
      // Under the phone's sheet, the address is set once the sheet has stepped back to the page beneath it.
      if (!onSheet()) navigate("/", "replace");
    }
    // Deletes in a row share one toast, so the earlier ones keep their Undo.
    if (deleted.length) quiet();
    deleted.push({ id, wasOpen });
    const batch = deleted;
    toast(batch.length > 1 ? `Deleted ${batch.length} notes` : name ? `Deleted "${name}"` : "Deleted", {
      action: {
        label: "Undo",
        keys: mouse.matches ? Shortcuts.undo : undefined,
        run: () => {
          deleted = [];
          undoable = false;
          void Promise.all(batch.map((note) => restore(note.id))).then(() => {
            // Undo puts you back where you were: in the note, if you were in it.
            const open = batch.find((note) => note.wasOpen);
            if (open && current() === null) void go(open.id, "replace");
          });
        },
      },
      onExpire: () => {
        deleted = [];
        undoable = false;
        for (const note of batch) settle(note.id);
      },
    });
    // After the toast: showing it ends the last one, whose expiry clears this.
    undoable = true;
  }

  // The app lives as long as the page, and so do these listeners.

  // Before the page's own keys: right after a delete, ⌘Z must reach the note before the editor's undo does.
  addEventListener(
    "keydown",
    (event) => {
      if (!undoable) return;
      if (!mod(event) || event.shiftKey || event.altKey || !letter(event, "z")) return;
      event.preventDefault();
      event.stopPropagation();
      undoable = false;
      act();
    },
    true,
  );

  addEventListener("keydown", (event) => {
    if (mod(event) && !event.altKey && !event.shiftKey && letter(event, "k")) {
      event.preventDefault();
      togglePalette(false);
    } else if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && letter(event, "n")) {
      // On a Mac, ⌥N would type a dead key (˜) into the note.
      event.preventDefault();
      newNote();
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

  addEventListener("popstate", () => void go(idFrom(location.pathname), "none"));

  addEventListener("pagehide", (event) => {
    // Kept for the Back button, the page may come back as it was, its note still on it: nothing is discarded then.
    const id = current();
    if (event.persisted && id) remember(id, editor.position());
    else leave();
    rescue();
    void flush();
  });

  // A phone may close a hidden page without warning: save, and keep a copy that's written at once.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    rescue();
    void flush();
  });

  return (
    <>
      <div class="page" inert={palette.open}>
        <Editor ref={(api) => (editor = api)} text={note()?.text ?? null} readonly={opening()} onCreate={onCreate} />
      </div>

      <Corner current={current()} onNew={newNote} focusEditor={() => editor.focus()} />

      <Palette
        current={current()}
        previous={previous()}
        onPick={(id, pointer) => void go(id, "push", mouse.matches || !pointer)}
        onDelete={onDelete}
        onNew={newNote}
        onSignedIn={onSignedIn}
        onClose={(pointer) => {
          if (!opening() && (mouse.matches || !pointer)) editor.focus();
        }}
        onStepBack={() => {
          const id = current();
          navigate(id ? `/${id}` : "/", "replace");
        }}
      />

      <Toasts />
      <Drop />
    </>
  );
}

/**
 * The note an address names, like `/7k3qx9m2da`, in either case. An older note's id, in base64url, is case-sensitive;
 * its address once began with `/n/`.
 */
function idFrom(path: string): string | null {
  const name = path.replace(/^\/(n\/)?/, "");
  return [name, name.toLowerCase()].find(isNoteId) ?? null;
}
