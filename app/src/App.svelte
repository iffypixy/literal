<script lang="ts">
  import { tick } from "svelte";
  import { fade } from "svelte/transition";
  import type * as Y from "yjs";
  import Editor from "./editor/Editor.svelte";
  import { letter, mod, shortcuts } from "./keys.ts";
  import {
    create,
    discardIfEmpty,
    find,
    flush,
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
  import { shorten, title } from "./notes/search.ts";
  import Panel from "./panel/Panel.svelte";
  import { account, session, signedIn } from "./sync/account.svelte.ts";
  import { sync, start as startSync } from "./sync/sync.svelte.ts";
  import { importFiles } from "./transfer/transfer.ts";
  import Keys from "./ui/Keys.svelte";
  import Toast from "./ui/Toast.svelte";
  import { tooltip } from "./ui/tooltip.ts";
  import { act, toast, toasts } from "./ui/toast.svelte.ts";

  /** Characters of a note's title a toast shows, and the window's title. */
  const NAME_SHOWN = 30;
  const TITLE_SHOWN = 60;
  /** Cursor positions remembered on this device, newest last. */
  const CURSORS_KEPT = 200;

  let editor: Editor;
  let panel: Panel;

  let current = $state<string | null>(null);
  let text = $state<Y.Text | null>(null);
  /** On a device with a mouse, the corner buttons step aside while you type, and come back when the mouse moves. */
  let typing = $state(false);
  /** A note was just deleted, and nothing typed since: ⌘Z means the note, wherever the cursor is. */
  let undoable = false;
  let dropping = $state(false);
  let browsing = $state(false);
  let drags = 0;

  const hover = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const cursors = new Map<string, [number, number]>(remembered());

  $effect(() => {
    void notes.version;
    const note = current ? find(current) : undefined;
    const name = note ? shorten(title(note.text), TITLE_SHOWN) : "";
    document.title = name ? `${name} — Blank` : "Blank";
  });

  setSignedIn(Boolean(account.email));
  void start();
  void go(idFrom(location.pathname), "none");
  if (account.email) startSync();
  void checkSession();

  /** Learns from the server whether this device is signed in, e.g. back from signing in with Google or Apple. */
  async function checkSession() {
    const returning = new URLSearchParams(location.search).has("signed-in");
    if (returning) history.replaceState(null, "", location.pathname);
    let email: string | null;
    try {
      email = await session();
    } catch {
      return; // offline: what this device remembers stands
    }
    if (email && email !== account.email) onsignedin(email, returning);
  }

  function onsignedin(email: string, announce = true) {
    signedIn(email);
    setSignedIn(true);
    startSync();
    if (announce) toast(`Signed in as ${email}`);
  }

  /** A problem stays in the corner until it's solved. */
  const problem = $derived(notes.failed ? "Can't save here" : sync.status);
  /** Otherwise the corner says, quietly, that the note is saved; or, on a blank page, that the others are still here. */
  const calm = $derived.by(() => {
    if (current) return "Saved";
    void notes.version;
    const count = notes.ready ? list().length : 0;
    return count ? `${count.toLocaleString()} ${count === 1 ? "note" : "notes"}` : "";
  });
  const explanations: Record<string, string> = {
    "Can't save here": "This browser can't save notes, so copy your text before closing",
    Offline: "Notes will sync when you're back online",
    "Not synced": "Notes are saved on this device and will sync when Blank connects",
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

  async function go(id: string | null, how: "push" | "replace" | "none") {
    if (id === current && id !== null) {
      editor.focus();
      return;
    }
    leave();
    if (id === null) {
      current = null;
      text = null;
      navigate("/", how);
      await tick();
      editor.focus();
      return;
    }
    const next = await open(id);
    if (!next) {
      toast("Note not found");
      void go(null, "replace");
      return;
    }
    current = id;
    text = next;
    navigate(`/n/${id}`, how);
    await tick();
    // On a phone, opening a note shouldn't throw the keyboard over it; tapping the text brings it up.
    if (hover) editor.focus(cursors.get(id));
  }

  /** Before switching notes: remember where the cursor was, and drop the note if it was emptied. */
  function leave() {
    if (!current) return;
    cursors.delete(current);
    cursors.set(current, editor.selection());
    while (cursors.size > CURSORS_KEPT) cursors.delete(cursors.keys().next().value ?? "");
    write("blank:cursors", JSON.stringify([...cursors]));
    discardIfEmpty(current);
  }

  function navigate(path: string, how: "push" | "replace" | "none") {
    if (how === "none" || location.pathname === path) return;
    if (how === "push") history.pushState(null, "", path);
    else history.replaceState(null, "", path);
  }

  function oncreate() {
    const note = create();
    current = note.id;
    text = note.text;
    navigate(`/n/${note.id}`, "replace");
  }

  function newNote() {
    panel.hide(false);
    void go(null, "push");
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
    toast(name ? `Deleted "${name}"` : "Deleted", {
      action: {
        label: "Undo",
        keys: hover ? shortcuts.undo : undefined,
        run: () => {
          restore(id);
          // Undo puts you back where you were: in the note, if you were in it.
          if (wasOpen && current === null) void go(id, "replace");
        },
      },
      onexpire: () => {
        undoable = false;
        settle(id);
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

  function idFrom(path: string): string | null {
    return /^\/n\/([\w-]{12})$/.exec(path)?.[1] ?? null;
  }

  // These are conveniences for this device only: a browser that refuses storage just goes without them.
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

  function remembered(): [string, [number, number]][] {
    try {
      return JSON.parse(read("blank:cursors") ?? "[]") as [string, [number, number]][];
    } catch {
      return []; // garbled: forget the cursors, keep the app
    }
  }

  const viewport = window.visualViewport;
  // iOS doesn't shrink the page for the keyboard; this keeps the end of the text above it.
  viewport?.addEventListener("resize", () => {
    document.documentElement.style.setProperty("--viewport-height", `${viewport.height}px`);
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
  onpopstate={() => void go(idFrom(location.pathname), "none")}
/>
<svelte:document {onvisibilitychange} />

<div class="page" inert={browsing}>
  <Editor bind:this={editor} {text} {oncreate} ontype={() => (typing = hover)} />

  <div class="corner" class:away={typing}>
    {#if problem || calm}
      <button class="status" class:problem={Boolean(problem)} onclick={explain}>{problem || calm}</button>
    {/if}
    <button aria-label="New note" {@attach tooltip("New note", shortcuts.new)} onclick={newNote}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" /></svg>
    </button>
    <button aria-label="Notes" {@attach tooltip("Notes", shortcuts.notes)} onclick={() => togglePanel(true)}>
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
  onpick={(id) => void go(id, "push")}
  {ondelete}
  {onsignedin}
  onclose={() => hover && editor.focus()}
/>

<Toast />

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
