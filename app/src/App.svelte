<script lang="ts">
  import { tick } from "svelte";
  import { fade } from "svelte/transition";
  import type * as Y from "yjs";
  import { isNoteId, MAX_LENGTH } from "../../protocol/protocol.ts";
  import Editor, { type Position } from "./editor/Editor.svelte";
  import { letter, mac, mod, shortcuts } from "./keys.ts";
  import {
    create,
    discardIfEmpty,
    count,
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
  } from "./notes/notes.svelte.ts";
  import { prepare, shorten, title } from "./notes/search.ts";
  import Panel from "./panel/Panel.svelte";
  import { FAREWELL, account, session, signedIn } from "./sync/account.svelte.ts";
  import { sync, start as startSync } from "./sync/sync.svelte.ts";
  import { importFiles } from "./transfer/transfer.ts";
  import Keys from "./ui/Keys.svelte";
  import Toast from "./ui/Toast.svelte";
  import { tooltip } from "./ui/tooltip.ts";
  import { act, quiet, toast, toasts } from "./ui/toast.svelte.ts";

  /** Characters of a note's title a toast shows, and the window's title. */
  const NAME_SHOWN = 30;
  const TITLE_SHOWN = 60;
  /** Cursor positions remembered on this device, newest last. */
  const CURSORS_KEPT = 200;

  let editor: Editor;
  let panel: Panel;

  let current = $state<string | null>(null);
  /** The note open before `current`: the panel starts on it, so ⌘K and Enter go back and forth between two notes. */
  let previous = $state<string | null>(null);
  let text = $state<Y.Text | null>(null);
  /** On a device with a mouse, the corner buttons step aside while you type, and come back when the mouse moves. */
  let typing = $state(false);
  /** A note was just deleted, and nothing typed since: ⌘Z means the note, wherever the cursor is. */
  let undoable = false;
  /** Notes deleted under the toast now showing: one Undo brings them all back. */
  let deleted: { id: string; wasOpen: boolean }[] = [];
  /** A note is on its way from disk: until it's shown, keys would land in the page being left. */
  let opening = $state(false);
  let dropping = $state(false);
  let browsing = $state(false);
  let drags = 0;

  const hover = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const cursors = new Map<string, Position>(remembered());

  $effect(() => {
    void notes.version;
    const note = current ? find(current) : undefined;
    const name = note ? shorten(title(note.text), TITLE_SHOWN) : "";
    document.title = name ? `${name} — Literal` : "Literal";
  });

  // A farewell left by signing out or deleting the account, which ends with a reload: said once it's done.
  const farewell = read(FAREWELL);
  if (farewell) {
    unset(FAREWELL);
    toast(farewell);
  }

  setSignedIn(Boolean(account.email));
  void start().then(() => prepare(list()));
  // "replace": an address that isn't a note becomes the blank page's own.
  void go(idFrom(location.pathname), "replace");
  if (account.email) startSync();
  void checkSession();

  /** Learns from the server whether this device is signed in, e.g. in another tab since this one opened. */
  async function checkSession() {
    let email: string | null;
    try {
      email = await session();
    } catch {
      return; // offline: what this device remembers stands
    }
    if (email && email !== account.email) onsignedin(email, false);
  }

  function onsignedin(email: string, announce = true) {
    signedIn(email);
    setSignedIn(true);
    startSync();
    if (announce) toast(`Signed in as ${email}`);
  }

  /** The open note is longer than sync takes: it stays on this device until it's shorter. */
  const tooLong = $derived.by(() => {
    void notes.version;
    return Boolean(account.email && current && length(current) > MAX_LENGTH);
  });
  /** A problem stays in the corner until it's solved. */
  const problem = $derived(notes.failed ? "Can't save here" : sync.status || (tooLong ? "Too long to sync" : ""));
  /** Otherwise the corner says, quietly, that the note is saved; or, on a blank page, that the others are still here. */
  const calm = $derived.by(() => {
    if (current) return "Saved";
    void notes.version;
    const live = notes.ready ? count() : 0;
    return live ? `${live.toLocaleString()} ${live === 1 ? "note" : "notes"}` : "";
  });
  const explanations: Record<string, string> = {
    "Can't save here": "This browser can't save notes, so copy your text before closing",
    Offline: "Notes will sync when you're back online",
    "Not synced": "Notes are saved on this device and will sync when Literal connects",
    "Too long to sync": `Notes sync up to ${MAX_LENGTH.toLocaleString()} characters, so split this one into shorter notes`,
  };

  function explain() {
    if (problem === "Sign in to sync") return panel.show(true, "sign-in");
    if (!problem && !current) return togglePanel(true);
    if (problem) toast(explanations[problem] ?? "");
    else if (account.email) toast("Notes save and sync as you type");
    else
      toast("Notes save on this device as you type", {
        action: { label: "Sync", run: () => panel.show(true, "sign-in") },
      });
    // A word of explanation, then back to writing: the click shouldn't take the cursor away.
    if (hover) void editor.focus();
  }

  /**
   * Shows the note `id`, or a blank page. `focus` puts the cursor in it: always with a mouse and keyboard; on a
   * phone only when a key asked for it (an iPad's keyboard), so opening a note doesn't throw the keyboard over it.
   */
  async function go(id: string | null, how: "push" | "replace" | "none", focus = hover) {
    if (id === current && id !== null) {
      if (focus) void editor.focus();
      return;
    }
    if (current !== null) previous = current;
    leave();
    if (id === null) {
      // From a blank page to a blank page: a few spaces typed there don't come along. (At startup, before the
      // editor is there, there's nothing to clear.)
      if (current === null) editor?.clear();
      current = null;
      text = null;
      navigate("/", how);
      await tick();
      void editor.focus();
      return;
    }
    opening = true;
    const next = await open(id).finally(() => (opening = false));
    if (!next) {
      toast("Note not found");
      void go(null, "replace");
      return;
    }
    current = id;
    text = next;
    navigate(`/${id}`, how);
    await tick();
    if (focus) void editor.focus(cursors.get(id));
  }

  /** Before switching notes: remember where the cursor was, and drop the note if it was emptied. */
  function leave() {
    if (!current) return;
    cursors.delete(current);
    cursors.set(current, editor.position());
    while (cursors.size > CURSORS_KEPT) cursors.delete(cursors.keys().next().value ?? "");
    write("literal:cursors", JSON.stringify([...cursors]));
    discardIfEmpty(current);
  }

  function navigate(path: string, how: "push" | "replace" | "none") {
    if (how === "none") return;
    // On a phone the panel's sheet is a step in history (so Back closes it): a note it opens takes that step's place.
    const sheet = Boolean(history.state?.sheet);
    if (location.pathname === path && !sheet) return;
    if (how === "push" && !sheet) history.pushState(null, "", path);
    else history.replaceState(null, "", path);
  }

  function oncreate() {
    const note = create();
    current = note.id;
    text = note.text;
    navigate(`/${note.id}`, "replace");
  }

  function newNote() {
    panel.hide(false, true);
    void go(null, "push");
  }

  function onpopstate() {
    // The panel stepping back by itself (closing on a phone) is nothing to act on.
    if (panel.stepped()) return;
    // Back with the panel open closes it, as it would anything on top.
    if (browsing) return panel.hide(true, true);
    void go(idFrom(location.pathname), "none");
  }

  function ondelete(id: string) {
    // Named, so it's clear which one went: Delete acts on whichever row is highlighted.
    const name = shorten(title(find(id)?.text ?? ""), NAME_SHOWN);
    void remove(id);
    const wasOpen = id === current;
    if (wasOpen) {
      current = null;
      text = null;
      navigate("/", "replace");
    }
    // Deletes in a row share one toast, so the earlier ones keep their Undo.
    if (deleted.length) quiet();
    deleted.push({ id, wasOpen });
    const batch = deleted;
    toast(batch.length > 1 ? `Deleted ${batch.length} notes` : name ? `Deleted "${name}"` : "Deleted", {
      action: {
        label: "Undo",
        keys: hover ? shortcuts.undo : undefined,
        run: () => {
          deleted = [];
          for (const note of batch) restore(note.id);
          // Undo puts you back where you were: in the note, if you were in it.
          const open = batch.find((note) => note.wasOpen);
          if (open && current === null) void go(open.id, "replace");
        },
      },
      onexpire: () => {
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
    typing = false;
  }

  /** Runs before the page's own keys: right after a delete, ⌘Z must reach the note before the editor's undo does. */
  function onkeydowncapture(event: KeyboardEvent) {
    if (!undoable || !toasts.current?.action) return;
    if (!mod(event) || event.shiftKey || event.altKey || !letter(event, "z")) return;
    event.preventDefault();
    event.stopPropagation();
    undoable = false;
    act();
  }

  function onkeydown(event: KeyboardEvent) {
    if (mod(event) && !event.altKey && !event.shiftKey && letter(event, "k")) {
      event.preventDefault();
      togglePanel(false);
    } else if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && letter(event, "n")) {
      // On a Mac, ⌥N would type a dead key (˜) into the note: this stops it.
      event.preventDefault();
      newNote();
    } else if (
      !browsing &&
      !opening &&
      document.activeElement === document.body &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      // Nothing has focus (after Esc, or a click on a toast that's gone): typing still lands on the page.
      void editor.focus();
    }
  }

  function onmousemove(event: MouseEvent) {
    if (typing && (Math.abs(event.movementX) > 1 || Math.abs(event.movementY) > 1)) typing = false;
  }

  function hasFiles(event: DragEvent): boolean {
    return event.dataTransfer?.types.includes("Files") ?? false;
  }

  function ondragenter(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    drags++;
    dropping = true;
  }

  function ondragleave(event: DragEvent) {
    if (!hasFiles(event)) return;
    drags = Math.max(0, drags - 1);
    if (!drags) dropping = false;
  }

  function ondragover(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }

  function ondrop(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    drags = 0;
    dropping = false;
    void importFiles([...(event.dataTransfer?.files ?? [])]);
  }

  function onpagehide() {
    leave();
    rescue();
    void flush();
  }

  // A phone may close a hidden page without warning: save, and keep a copy that's written at once.
  function onvisibilitychange() {
    if (!document.hidden) return;
    rescue();
    void flush();
  }

  /**
   * The note an address names: `/7k3qx9m2da`, in either case. An older note's id, in base64url, is case-sensitive;
   * its address once began with `/n/`.
   */
  function idFrom(path: string): string | null {
    const name = path.replace(/^\/(n\/)?/, "");
    return [name, name.toLowerCase()].find(isNoteId) ?? null;
  }

  // These are conveniences for this device only: a browser that refuses storage just goes without them.
  function unset(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      // see read()
    }
  }

  function read(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function write(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // see read()
    }
  }

  function remembered(): [string, Position][] {
    try {
      return JSON.parse(read("literal:cursors") ?? "[]") as [string, Position][];
    } catch {
      return []; // garbled: forget the cursors, keep the app
    }
  }

  const viewport = window.visualViewport;
  // iOS doesn't shrink the page for the keyboard; this keeps the end of the text above it. A pinch zoom shrinks
  // what's visible too, but not the page: scaled back, it leaves the page its size.
  viewport?.addEventListener("resize", () => {
    document.documentElement.style.setProperty("--viewport-height", `${viewport.height * viewport.scale}px`);
  });
</script>

<svelte:window
  {onkeydowncapture}
  {onkeydown}
  oninput={() => (undoable = false)}
  {onmousemove}
  {ondragenter}
  {ondragleave}
  {ondragover}
  {ondrop}
  {onpagehide}
  {onpopstate}
/>
<svelte:document {onvisibilitychange} />

<div class="page" inert={browsing}>
  <Editor bind:this={editor} {text} readonly={opening} {oncreate} ontype={() => (typing = hover)} />

  <div class="corner" class:away={typing}>
    {#if problem || calm}
      <button class="status" class:problem={Boolean(problem)} onclick={explain}>{problem || calm}</button>
    {/if}
    <button
      aria-label="New note"
      aria-keyshortcuts="Alt+N"
      {@attach tooltip("New note", shortcuts.new)}
      onclick={newNote}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" /></svg>
    </button>
    <button
      aria-label="Notes"
      aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}
      {@attach tooltip("Notes", shortcuts.notes)}
      onclick={() => togglePanel(true)}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6h11M4.5 10h11M4.5 14h7" /></svg>
    </button>
  </div>

  <!-- Only on a blank page, where it covers nothing: gone with the first word, back with every new page. -->
  {#if hover && !current}
    <p class="hint" aria-hidden="true" out:fade={{ duration: 150 }}>
      <span><Keys keys={shortcuts.new} /> new note</span>
      <span><Keys keys={shortcuts.notes} /> notes</span>
    </p>
  {/if}
</div>

<Panel
  bind:this={panel}
  bind:open={browsing}
  {current}
  {previous}
  onpick={(id, pointer) => void go(id, "push", hover || !pointer)}
  {ondelete}
  onnew={newNote}
  {onsignedin}
  onclose={(pointer) => {
    if (!opening && (hover || !pointer)) void editor.focus();
  }}
/>

<Toast />

<!-- A problem in the corner is also said aloud, once, by a screen reader. -->
<p class="visually-hidden" aria-live="polite">{problem}</p>

{#if dropping}
  <div class="drop" aria-hidden="true"><p>Drop to import</p></div>
{/if}

<style>
  /* Centered on the page's first line, with the icons' ink (not their buttons) on the page's 16px right edge. */
  .corner {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 10px);
    right: calc(env(safe-area-inset-right, 0px) + 5px);
    display: flex;
    align-items: center;
    gap: 2px;
    z-index: 10;
  }

  /*
   * A patch of paper under the buttons, so a long first line passes under them instead of through. It ends where
   * the first line does (6.5px above the buttons' bottom): a second line goes on showing whole beneath it.
   */
  .corner::before {
    content: "";
    position: absolute;
    inset: -10px -5px 6.5px -24px;
    z-index: -1;
    background: linear-gradient(to right, transparent, var(--bg) 24px);
    transition: opacity var(--brief) ease;
  }

  /* The buttons step aside while you type, with their paper; a problem, when there is one, stays. */
  .corner.away::before,
  .corner.away button:not(.problem) {
    opacity: 0;
    transition-duration: 300ms;
  }

  /* Reached by Tab (Esc, then Tab, leaves the page), they're back at once: focus is never on something unseen. */
  .corner.away:focus-within::before,
  .corner.away:focus-within button {
    opacity: 1;
    transition-duration: 0ms;
  }

  .corner button {
    display: grid;
    place-items: center;
    width: var(--control);
    height: var(--control);
    border-radius: var(--radius-small);
    color: var(--muted);
    transition:
      opacity var(--brief) ease,
      color var(--quick) ease,
      background-color var(--quick) ease,
      transform var(--quick) var(--ease-out);
  }

  .corner button:active {
    transform: scale(0.97);
  }

  .corner svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
  }

  .corner path {
    stroke-width: var(--stroke);
    vector-effect: non-scaling-stroke;
  }

  @media (hover: hover) and (pointer: fine) {
    .corner button:hover {
      color: var(--text);
      background: var(--hover);
    }
  }

  @media (pointer: coarse) {
    .corner svg {
      width: 20px;
      height: 20px;
    }
  }

  /* Its paper, like the patch, stops where the first line does. */
  .corner .status {
    width: auto;
    margin-right: 4px;
    padding: 0 var(--inset);
    border-radius: var(--radius-small);
    background: linear-gradient(var(--bg), var(--bg)) top / 100% calc(100% - 6.5px) no-repeat;
    color: var(--muted);
    animation: appear var(--brief) var(--ease-out);
  }

  .corner .problem {
    color: var(--text);
  }

  /* Like nano's bottom line: the keys worth knowing. */
  .hint {
    position: fixed;
    right: calc(env(safe-area-inset-right, 0px) + var(--edge));
    bottom: calc(env(safe-area-inset-bottom, 0px) + var(--edge));
    display: flex;
    gap: 2ch;
    margin: 0;
    color: var(--faint);
    pointer-events: none;
  }

  .hint span {
    display: flex;
    align-items: baseline;
    gap: 1ch;
  }

  .drop {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    padding: var(--edge);
    background: var(--scrim);
    z-index: 40;
    pointer-events: none;
    animation: appear var(--brief) var(--ease-out);
  }

  .drop p {
    display: grid;
    place-items: center;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    margin: 0;
    border: 1px dashed var(--muted);
    border-radius: var(--radius);
    color: var(--muted);
  }

  @keyframes appear {
    from {
      opacity: 0;
    }
  }
</style>
