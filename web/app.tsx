import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js";
import type * as Y from "yjs";
import { isNoteId, MaxLength } from "../protocol.ts";
import { mouse } from "./device.ts";
import { Editor, type EditorApi, type Position } from "./editor/editor.tsx";
import { caps, letter, mac, mod, shortcuts } from "./keys.ts";
import {
  count,
  create,
  discardIfEmpty,
  exists,
  find,
  flush,
  length,
  list,
  notes,
  open,
  remove,
  rescue,
  restore,
  setSignedIn,
  settle,
  start,
} from "./notes/notes.ts";
import { prepare, quoted, shorten, title } from "./notes/search.ts";
import { Panel, type PanelApi } from "./panel/panel.tsx";
import { FarewellKey, account, session, signedIn } from "./sync/account.ts";
import { sync, start as startSync } from "./sync/sync.ts";
import { importFiles } from "./transfer/transfer.ts";
import { act, quiet, toast, Toasts } from "./ui/toast.tsx";
import { tooltip } from "./ui/tooltip.ts";
import { stayUpToDate } from "./update.ts";
import "./app.css";

/** Characters of a note's title the window's title shows. */
const TitleShown = 60;
/** Cursor positions remembered on this device, newest last. */
const CursorsKept = 200;
const CursorsKey = "literal:cursors";
/** What tapping the corner says about each problem it can show. */
const Explanations = {
  "Can't save here": "This browser can't save notes, so copy your text before closing",
  Offline: "Notes will sync when you're back online",
  "Not synced": "Notes are saved on this device and will sync when Literal connects",
  "Too long to sync": `Notes sync up to ${MaxLength.toLocaleString()} characters, so split this one into shorter notes`,
};

type How = "push" | "replace" | "none";

export function App() {
  // Set by the components as they render, before anything here runs.
  let editor!: EditorApi;
  let panel!: PanelApi;

  const [note, setNote] = createSignal<{ id: string; text: Y.Text } | null>(null);
  /** The note open before this one: the panel starts on it, so ⌘K and Enter go back and forth between two notes. */
  const [previous, setPrevious] = createSignal<string | null>(null);
  /** On a device with a mouse, the corner buttons step aside while you type, and come back when the mouse moves. */
  const [typing, setTyping] = createSignal(false);
  /** A note is on its way from disk: until it's shown, keys would land in the page being left. */
  const [opening, setOpening] = createSignal(false);
  const [browsing, setBrowsing] = createSignal(false);
  const [dropping, setDropping] = createSignal(false);
  /** A note was just deleted, and nothing typed since: ⌘Z means the note, wherever the cursor is. */
  let undoable = false;
  /** Notes deleted under the toast now showing: one Undo brings them all back. */
  let deleted: { id: string; wasOpen: boolean }[] = [];
  let drags = 0;

  const cursors = new Map<string, Position>(remembered());
  const current = () => note()?.id ?? null;

  /** The open note is longer than sync takes: it stays on this device until it's shorter. */
  const tooLong = createMemo(() => {
    void notes.version;
    const id = current();
    return Boolean(account.email && id && length(id) > MaxLength);
  });
  /** A problem stays in the corner until it's solved. */
  const problem = () => (notes.failed ? "Can't save here" : sync.status || (tooLong() ? "Too long to sync" : ""));
  /** Otherwise the corner says, quietly, that the note is saved; or on a blank page, that the others are there. */
  const calm = createMemo(() => {
    if (current()) return "Saved";
    void notes.version;
    const live = notes.ready ? count() : 0;
    return live ? `${live.toLocaleString()} ${live === 1 ? "note" : "notes"}` : "";
  });

  createEffect(() => {
    void notes.version;
    const id = current();
    const name = id ? shorten(title(find(id)?.text ?? ""), TitleShown) : "";
    document.title = name ? `${name} — Literal` : "Literal";
  });

  // A note erased while open, by the server or another tab, leaves a blank page behind.
  createEffect(() => {
    void notes.version;
    const id = current();
    if (id && !exists(id)) void go(null, "replace");
  });

  onMount(() => {
    // A farewell left by signing out or deleting the account, which ends with a reload: said once it's done.
    const farewell = read(FarewellKey);
    if (farewell) {
      unset(FarewellKey);
      toast(farewell);
    }
    setSignedIn(Boolean(account.email));
    void start().then(() => prepare(list()));
    // "replace": an address that isn't a note becomes the blank page's own.
    void go(idFrom(location.pathname), "replace");
    if (account.email) startSync();
    void checkSession();
    stayUpToDate(browsing);
  });

  /** Learns from the server whether this device is signed in, e.g. in another tab since this one opened. */
  async function checkSession() {
    let email: string | null;
    try {
      email = await session();
    } catch {
      return; // offline: what this device remembers stands
    }
    if (email && email !== account.email) onSignedIn(email, false);
  }

  function onSignedIn(email: string, announce = true) {
    signedIn(email);
    setSignedIn(true);
    startSync();
    if (announce) toast(`Signed in as ${email}`);
  }

  function explain() {
    const shown = problem();
    if (shown === "Sign in to sync") return panel.show(true, "sign-in");
    if (!shown && !current()) return togglePanel(true);
    if (shown) toast(Explanations[shown]);
    else if (account.email) toast("Notes save and sync as you type");
    else
      toast("Notes save on this device as you type", {
        action: { label: "Sync", run: () => panel.show(true, "sign-in") },
      });
    // A word of explanation, then back to writing: the click shouldn't take the cursor away.
    if (mouse.matches) editor.focus();
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
    if (focus) editor.focus(cursors.get(id));
  }

  /** Before switching notes: remember where the cursor was, and drop the note if it was emptied. */
  function leave() {
    const id = current();
    if (!id) return;
    keepCursor(id);
    discardIfEmpty(id);
  }

  function keepCursor(id: string) {
    cursors.delete(id);
    cursors.set(id, editor.position());
    for (const oldest of cursors.keys()) {
      if (cursors.size <= CursorsKept) break;
      cursors.delete(oldest);
    }
    write(CursorsKey, JSON.stringify([...cursors]));
  }

  function navigate(path: string, how: How) {
    if (how === "none") return;
    // On a phone the panel's sheet is a step in history (so Back closes it): a note it opens takes that step's place.
    const sheet = Boolean(history.state?.sheet);
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
    panel.hide(false, true);
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
      if (!history.state?.sheet) navigate("/", "replace");
    }
    // Deletes in a row share one toast, so the earlier ones keep their Undo.
    if (deleted.length) quiet();
    deleted.push({ id, wasOpen });
    const batch = deleted;
    toast(batch.length > 1 ? `Deleted ${batch.length} notes` : name ? `Deleted "${name}"` : "Deleted", {
      action: {
        label: "Undo",
        keys: mouse.matches ? shortcuts.undo : undefined,
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

  function togglePanel(pointer: boolean) {
    panel.toggle(pointer);
    setTyping(false);
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
      togglePanel(false);
    } else if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && letter(event, "n")) {
      // On a Mac, ⌥N would type a dead key (˜) into the note: this stops it.
      event.preventDefault();
      newNote();
    } else if (
      !browsing() &&
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

  addEventListener("mousemove", (event) => {
    if (typing() && (Math.abs(event.movementX) > 1 || Math.abs(event.movementY) > 1)) setTyping(false);
  });

  addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    drags++;
    setDropping(true);
  });

  addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    drags = Math.max(0, drags - 1);
    if (!drags) setDropping(false);
  });

  addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });

  addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    drags = 0;
    setDropping(false);
    void importFiles([...(event.dataTransfer?.files ?? [])]);
  });

  addEventListener("popstate", () => {
    if (panel.stepped()) {
      // The sheet stepped back to the page beneath it, whose note may have been deleted meanwhile.
      const id = current();
      navigate(id ? `/${id}` : "/", "replace");
      return;
    }
    // Back with the panel open closes it, as it would anything on top.
    if (browsing()) return panel.hide(true, true);
    void go(idFrom(location.pathname), "none");
  });

  addEventListener("pagehide", (event) => {
    // Kept for the Back button, the page may come back as it was, its note still on it: nothing is discarded then.
    const id = current();
    if (event.persisted && id) keepCursor(id);
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

  const viewport = window.visualViewport;
  // iOS doesn't shrink the page for the keyboard; this keeps the end of the text above it. A pinch zoom shrinks
  // what's visible too, but not the page: scaled back, it leaves the page its size.
  viewport?.addEventListener("resize", () => {
    document.documentElement.style.setProperty("--viewport-height", `${viewport.height * viewport.scale}px`);
  });

  return (
    <>
      <div class="page" inert={browsing()}>
        <Editor
          ref={(api) => (editor = api)}
          text={note()?.text ?? null}
          readonly={opening()}
          onCreate={onCreate}
          onType={() => setTyping(mouse.matches)}
        />

        <div class="corner" classList={{ away: typing() }}>
          <Show when={problem() || calm()}>
            {(label) => (
              <button class="status" classList={{ problem: Boolean(problem()) }} onClick={explain}>
                {label()}
              </button>
            )}
          </Show>
          <button
            aria-label="New note"
            aria-keyshortcuts="Alt+N"
            ref={(button) => tooltip(button, "New note", shortcuts.new)}
            onClick={newNote}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 4.5v11M4.5 10h11" />
            </svg>
          </button>
          <button
            aria-label="Notes"
            aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}
            ref={(button) => tooltip(button, "Notes", shortcuts.notes)}
            onClick={() => togglePanel(true)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4.5 6h11M4.5 10h11M4.5 14h7" />
            </svg>
          </button>
        </div>

        {/* Only on a blank page, where it covers nothing: gone with the first word, back with every new page. */}
        {mouse.matches && (
          <p class="hint" classList={{ gone: current() !== null }} aria-hidden="true">
            <span>{caps(shortcuts.new)} new note</span>
            <span>{caps(shortcuts.notes)} notes</span>
          </p>
        )}
      </div>

      <Panel
        ref={(api) => (panel = api)}
        open={browsing()}
        onOpenChange={setBrowsing}
        current={current()}
        previous={previous()}
        onPick={(id, pointer) => void go(id, "push", mouse.matches || !pointer)}
        onDelete={onDelete}
        onNew={newNote}
        onSignedIn={onSignedIn}
        onClose={(pointer) => {
          if (!opening() && (mouse.matches || !pointer)) editor.focus();
        }}
      />

      <Toasts />

      {/* A problem in the corner is also said aloud, once, by a screen reader. */}
      <p class="visually-hidden" aria-live="polite">
        {problem()}
      </p>

      <Show when={dropping()}>
        <div class="drop" aria-hidden="true">
          <p>Drop to import</p>
        </div>
      </Show>
    </>
  );
}

// Conveniences kept for this device only: a browser that refuses storage just goes without them.

function remembered(): [string, Position][] {
  let saved: unknown;
  try {
    saved = JSON.parse(read(CursorsKey) ?? "[]");
  } catch {
    return []; // garbled: forget the cursors, keep the app
  }
  return Array.isArray(saved) ? saved.filter(isCursor) : [];
}

function isCursor(entry: unknown): entry is [string, Position] {
  if (!Array.isArray(entry) || typeof entry[0] !== "string" || !Array.isArray(entry[1])) return false;
  const position: unknown[] = entry[1];
  return (position.length === 2 || position.length === 3) && position.every((at) => typeof at === "number");
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function unset(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // no storage, so nothing to unset
  }
}

/**
 * The note an address names: `/7k3qx9m2da`, in either case. An older note's id, in base64url, is case-sensitive;
 * its address once began with `/n/`.
 */
function idFrom(path: string): string | null {
  const name = path.replace(/^\/(n\/)?/, "");
  return [name, name.toLowerCase()].find(isNoteId) ?? null;
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // no storage, so nothing kept
  }
}

function hasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}
