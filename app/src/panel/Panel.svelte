<script lang="ts">
  import { tick } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { mod, shortcuts } from "../keys.ts";
  import { list, notes, unsynced, type Note } from "../notes/notes.svelte.ts";
  import { describe, parse, search } from "../notes/search.ts";
  import { account, deleteAccount, signOut } from "../sync/account.svelte.ts";
  import { sync } from "../sync/sync.svelte.ts";
  import { exportAll, importFiles } from "../transfer/transfer.ts";
  import Keys from "../ui/Keys.svelte";
  import { tooltip } from "../ui/tooltip.ts";
  import Back from "./Back.svelte";
  import SignIn from "./SignIn.svelte";

  /** What the panel shows: the notes, signing in, a question before something that can't be undone, or the keys. */
  export type View = "notes" | "sign-in" | "sign-out" | "delete" | "keys";

  type Props = {
    /** The note open behind the panel, if any. */
    current: string | null;
    /** `pointer` says whether a click (not a key) chose it, which decides if the panel animates away. */
    onpick: (id: string, pointer: boolean) => void;
    ondelete: (id: string) => void;
    onclose: () => void;
    onsignedin: (email: string) => void;
    /** Whether the panel is open: the page behind it goes inert meanwhile. */
    open?: boolean;
  };

  let { current, onpick, ondelete, onclose, onsignedin, open = $bindable(false) }: Props = $props();

  /** Rows rendered at a time; more appear as the list scrolls. */
  const PAGE = 50;
  const touch = matchMedia("(pointer: coarse)");
  // Safari erases a site's storage after 7 days without a visit, unless it's on the Home Screen.
  const fragile =
    /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent) &&
    !matchMedia("(display-mode: standalone)").matches;

  let overlay: HTMLDivElement;
  let input = $state<HTMLInputElement>();
  let rows = $state<HTMLUListElement>();
  let panel: HTMLDivElement;
  let picker = $state<HTMLInputElement>();

  let query = $state("");
  let active = $state(0);
  let limit = $state(PAGE);
  let now = $state(Date.now());
  let menu = $state(false);
  let view = $state<View>("notes");
  let waiting = $state(0);
  let problem = $state("");
  /** Notes on their way out, whose rows collapse instead of vanishing. */
  let leaving = new Set<string>();

  const keyList: [string[], string][] = [
    [shortcuts.notes, "Open or close your notes"],
    [shortcuts.new, "New note"],
    [shortcuts.move, "Choose a note"],
    [shortcuts.open, "Open it"],
    [shortcuts.delete, "Delete it"],
    [shortcuts.undo, "Bring it back"],
    [shortcuts.close, "Close"],
  ];

  const words = $derived(parse(query));
  const results = $derived.by(() => {
    void notes.version;
    return open ? search(list(), words) : [];
  });
  const shown = $derived(results.slice(0, limit));
  const selected = $derived(shown[active]);

  export function toggle(pointer: boolean) {
    if (open) hide(pointer);
    else show(pointer);
  }

  /** Opens the panel, at `start`. Keys open it instantly; a click or tap gets a short animation. */
  export function show(pointer: boolean, start: View = "notes") {
    if (open) {
      view = start;
      return;
    }
    open = true;
    view = start;
    query = "";
    limit = PAGE;
    menu = false;
    now = Date.now();
    // The note you're in is the one you least want: start on the one before it.
    active = Math.max(
      0,
      list().findIndex((note) => note.id !== current),
    );
    delete overlay.dataset.closing;
    panel.style.transform = "";
    panel.style.transition = "";
    if (pointer) overlay.dataset.motion = "";
    else delete overlay.dataset.motion;
    overlay.hidden = false;
    // Once the view is on screen (it may have just changed), within the same task: no keystroke gets lost.
    void tick().then(() => {
      if (rows) rows.scrollTop = 0;
      // On a phone the keyboard would cover the list; the search field is a tap away.
      if (touch.matches || !input) panel.focus();
      else input.focus();
    });
  }

  export function hide(pointer: boolean) {
    if (!open) return;
    open = false;
    menu = false;
    if (!pointer || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }
    overlay.dataset.closing = "";
    panel.addEventListener("animationend", finish, { once: true });
  }

  function finish() {
    // Reopened while closing: the close is off.
    if (open) return;
    panel.style.transform = "";
    panel.style.transition = "";
    overlay.hidden = true;
    delete overlay.dataset.closing;
    onclose();
  }

  function pick(note: Note | undefined, pointer: boolean) {
    if (!note) return;
    onpick(note.id, pointer);
    hide(pointer);
  }

  /** Deletes the note. Its row collapses when a click or swipe deleted it; a key just takes it away, like any key. */
  function remove(note: Note | undefined, pointer: boolean) {
    if (!note) return;
    if (pointer) leaving.add(note.id);
    const index = shown.indexOf(note);
    ondelete(note.id);
    void tick().then(() => (active = Math.min(index, Math.max(0, results.length - 1))));
  }

  function move(by: number) {
    if (!results.length) return;
    active = Math.min(results.length - 1, Math.max(0, active + by));
    if (active >= limit) limit += PAGE;
    void tick().then(() => rows?.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest" }));
  }

  function oninput() {
    active = 0;
    limit = PAGE;
    if (rows) rows.scrollTop = 0;
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(selected, false);
    } else if (erasesNothing(event)) {
      // A key with nothing to erase in the field means the note.
      event.preventDefault();
      remove(selected, false);
    }
  }

  /** ⌘⌫ with nothing before the cursor, or Delete (as on Windows) with nothing after it. */
  function erasesNothing(event: KeyboardEvent): boolean {
    if (!input || input.selectionStart !== input.selectionEnd || event.altKey || event.shiftKey) return false;
    if (event.key === "Backspace") return mod(event) && input.selectionStart === 0;
    if (event.key === "Delete") return !mod(event) && input.selectionEnd === input.value.length;
    return false;
  }

  function onescape(event: KeyboardEvent) {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    if (menu) menu = false;
    else hide(false);
  }

  function onclick(event: MouseEvent) {
    if (menu && !(event.target as Element).closest(".menu, .more")) menu = false;
  }

  /** Rows collapse when their note is deleted, and vanish instantly when a search filters them out. */
  function collapse(node: HTMLElement, id: string) {
    // The mark is used up here, when the row leaves: the delete is saved first, so that's after a tick or two.
    if (!leaving.delete(id)) return { duration: 0 };
    const height = node.offsetHeight;
    return {
      duration: 200,
      easing: cubicOut,
      // The text is gone in the first moment; then the gap closes, so the rows below rise into space, not into words.
      css: (t: number) =>
        `height: ${t * height}px; opacity: ${Math.max(0, 2 * t - 1)}; overflow: hidden; pointer-events: none;`,
    };
  }

  /** Loads the next page of rows when the end of the list scrolls into view. */
  function more(node: HTMLElement) {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) limit += PAGE;
      },
      { root: rows, rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }

  /** Swipe a row left to delete its note: far enough, or fast enough. Touch only; a mouse gets the × button. */
  function swipe(note: Note) {
    return (node: HTMLElement) => {
      let start: { x: number; y: number; time: number } | null = null;
      let dragging = false;
      let dx = 0;

      function down(event: PointerEvent) {
        if (event.pointerType !== "touch" || start) return;
        start = { x: event.clientX, y: event.clientY, time: event.timeStamp };
        dragging = false;
        dx = 0;
      }

      function moveTo(event: PointerEvent) {
        if (!start) return;
        dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (!dragging) {
          if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) start = null;
          else if (Math.abs(dx) > 8) {
            dragging = true;
            node.setPointerCapture(event.pointerId);
            node.parentElement?.setAttribute("data-swiping", "");
          }
          return;
        }
        // Left follows the finger; right resists.
        const x = dx < 0 ? dx : dx * 0.15;
        node.style.transition = "none";
        node.style.transform = `translateX(${x}px)`;
      }

      function up(event: PointerEvent) {
        if (!start) return;
        const velocity = -dx / Math.max(1, event.timeStamp - start.time);
        start = null;
        if (!dragging) return;
        dragging = false;
        node.style.transition = "transform 200ms var(--ease-out)";
        if (-dx > node.offsetWidth * 0.4 || (velocity > 0.5 && dx < -40)) {
          node.style.transform = "translateX(-100%)";
          node.addEventListener("transitionend", () => remove(note, true), { once: true });
        } else {
          node.style.transform = "";
          node.addEventListener("transitionend", () => node.parentElement?.removeAttribute("data-swiping"), {
            once: true,
          });
        }
      }

      // A swipe ends with a click on the row; it shouldn't open the note.
      function click(event: MouseEvent) {
        if (node.style.transform) event.stopPropagation();
      }

      node.addEventListener("pointerdown", down);
      node.addEventListener("pointermove", moveTo);
      node.addEventListener("pointerup", up);
      node.addEventListener("pointercancel", up);
      node.addEventListener("click", click, true);
      return () => {
        node.removeEventListener("pointerdown", down);
        node.removeEventListener("pointermove", moveTo);
        node.removeEventListener("pointerup", up);
        node.removeEventListener("pointercancel", up);
        node.removeEventListener("click", click, true);
      };
    };
  }

  /** Drag the sheet down by its handle to close it, as on any phone. */
  function grab(node: HTMLElement) {
    let start: { y: number; time: number } | null = null;
    let dy = 0;

    function down(event: PointerEvent) {
      // A second finger doesn't take over the drag.
      if (start) return;
      start = { y: event.clientY, time: event.timeStamp };
      dy = 0;
      node.setPointerCapture(event.pointerId);
      panel.style.transition = "none";
    }

    function moveTo(event: PointerEvent) {
      if (!start) return;
      dy = event.clientY - start.y;
      // Down follows the finger; up resists.
      panel.style.transform = `translateY(${dy > 0 ? dy : dy * 0.1}px)`;
    }

    function up(event: PointerEvent) {
      if (!start) return;
      const velocity = dy / Math.max(1, event.timeStamp - start.time);
      start = null;
      panel.style.transition = "transform 240ms var(--ease-drawer)";
      if (dy > 120 || (velocity > 0.5 && dy > 24)) {
        panel.style.transform = "translateY(100%)";
        open = false;
        panel.addEventListener("transitionend", finish, { once: true });
      } else {
        panel.style.transform = "";
      }
    }

    node.addEventListener("pointerdown", down);
    node.addEventListener("pointermove", moveTo);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
    return () => {
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointermove", moveTo);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
    };
  }

  function onpicked() {
    if (!picker) return;
    const files = [...(picker.files ?? [])];
    picker.value = "";
    menu = false;
    if (files.length) void importFiles(files);
  }

  async function back() {
    view = "notes";
    problem = "";
    await tick();
    if (!touch.matches) input?.focus();
  }

  /** Signs out at once if everything is synced; otherwise asks first. */
  function leave() {
    menu = false;
    waiting = unsynced();
    if (waiting || sync.status) view = "sign-out";
    else void signOut();
  }

  async function erase() {
    problem = (await deleteAccount().catch(() => "You're offline. Connect and try again.")) ?? "";
  }

  function signedIn(email: string) {
    view = "notes";
    hide(true);
    onsignedin(email);
  }

  const minute = 60_000;
  const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const dayAndYear = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

  function ago(at: number): string {
    const age = now - at;
    if (age < minute) return "Just now";
    if (age < 60 * minute) return `${Math.floor(age / minute)}m`;
    const date = new Date(at);
    const today = new Date(now);
    if (date.toDateString() === today.toDateString()) return clock.format(date);
    today.setDate(today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return "Yesterday";
    if (date.getFullYear() === today.getFullYear()) return day.format(date);
    return dayAndYear.format(date);
  }
</script>

<svelte:window onkeydown={onescape} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="overlay"
  bind:this={overlay}
  role="dialog"
  aria-modal="true"
  aria-label="Notes"
  tabindex="-1"
  hidden
  {onclick}
>
  <div class="scrim" onclick={() => hide(true)} aria-hidden="true"></div>
  <div class="panel" bind:this={panel} tabindex="-1">
    <div class="grab" {@attach grab} aria-hidden="true"><span></span></div>

    {#if view === "sign-in"}
      <SignIn onback={back} ondone={signedIn} />
    {:else if view === "sign-out"}
      <div class="ask">
        <h2>
          {waiting === 1 ? "1 note hasn't" : waiting ? `${waiting} notes haven't` : "Some notes may not have"} synced yet.
        </h2>
        <p>Signing out erases this device's notes. Wait until you're back online to keep every change.</p>
        <div class="choices">
          <button class="quiet" onclick={back}>Wait</button>
          <button class="danger" onclick={() => void signOut()}>Sign out anyway</button>
        </div>
      </div>
    {:else if view === "keys"}
      <div class="ask">
        <Back onclick={back} />
        <h2>Keyboard shortcuts</h2>
        <dl class="keys">
          {#each keyList as [keys, what]}
            <dt><Keys {keys} /></dt>
            <dd>{what}</dd>
          {/each}
        </dl>
      </div>
    {:else if view === "delete"}
      <div class="ask">
        <h2>Delete your account and all synced notes?</h2>
        <p>This can't be undone. <button class="link" onclick={exportAll}>Export notes first</button></p>
        {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
        <div class="choices">
          <button class="quiet" onclick={back}>Cancel</button>
          <button class="danger" onclick={erase}>Delete account</button>
        </div>
      </div>
    {:else}
      <div class="search">
        <input
          bind:this={input}
          bind:value={query}
          {oninput}
          {onkeydown}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="notes-list"
          aria-activedescendant={selected ? `note-${selected.id}` : undefined}
          aria-label="Search notes"
          placeholder="Search"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          enterkeyhint="go"
        />
      </div>

      <ul class="rows" role="listbox" id="notes-list" aria-label="Notes" bind:this={rows} hidden={!shown.length}>
        {#each shown as note, index (note.id)}
          {@const parts = describe(note, words)}
          <li
            id="note-{note.id}"
            role="option"
            aria-selected={index === active}
            aria-current={note.id === current ? "true" : undefined}
            out:collapse={note.id}
            onpointermove={(event) => event.pointerType === "mouse" && (active = index)}
          >
            <span class="behind" aria-hidden="true">Delete</span>
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div class="row" {@attach swipe(note)} onclick={() => pick(note, true)} role="presentation">
              <div class="line">
                <span class="title">
                  {#each parts.title as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}
                </span>
                <span class="time">{ago(note.editedAt)}</span>
                <button
                  class="delete"
                  aria-label="Delete note"
                  {@attach tooltip("Delete", shortcuts.delete)}
                  tabindex="-1"
                  onclick={(event) => {
                    event.stopPropagation();
                    remove(note, true);
                  }}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" /></svg>
                </button>
              </div>
              {#if parts.snippet.some((part) => part.text)}
                <div class="snippet">
                  {#each parts.snippet as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}
                </div>
              {/if}
            </div>
          </li>
        {/each}
        {#if shown.length < results.length}
          <li class="sentinel" aria-hidden="true" {@attach more}></li>
        {/if}
      </ul>

      {#if notes.ready && !results.length}
        <p class="empty">{words.length ? "No matches." : "No notes yet."}</p>
      {/if}

      <footer>
        {#if account.email}
          <span class="account" title={account.email}>{account.email}</span>
        {:else}
          <button class="sync" onclick={() => (view = "sign-in")}>
            {fragile ? "Sync to keep notes safe" : "Sync across devices"}&ensp;→
          </button>
        {/if}
        <button class="more" aria-label="More" aria-expanded={menu} onclick={() => (menu = !menu)}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="5" cy="10" r="1.25" /><circle cx="10" cy="10" r="1.25" /><circle cx="15" cy="10" r="1.25" />
          </svg>
        </button>
        {#if menu}
          <div class="menu" role="menu">
            {#if !touch.matches}
              <button
                role="menuitem"
                onclick={() => {
                  menu = false;
                  view = "keys";
                }}>Keyboard shortcuts</button
              >
              <hr />
            {/if}
            <button role="menuitem" onclick={() => picker?.click()}>Import .txt files</button>
            <button
              role="menuitem"
              onclick={() => {
                menu = false;
                exportAll();
              }}>Export all notes</button
            >
            {#if account.email}
              <hr />
              <button role="menuitem" onclick={leave}>Sign out</button>
              <button
                role="menuitem"
                class="danger-item"
                onclick={() => {
                  menu = false;
                  view = "delete";
                }}>Delete account</button
              >
            {/if}
          </div>
        {/if}
        <input
          bind:this={picker}
          onchange={onpicked}
          type="file"
          accept=".txt,.text,.md,.markdown,text/plain,text/markdown"
          multiple
          hidden
        />
      </footer>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    overflow: hidden;
    z-index: 20;
  }

  .scrim {
    position: absolute;
    inset: 0;
    background: var(--scrim);
  }

  .panel {
    position: relative;
    display: flex;
    flex-direction: column;
    width: min(560px, calc(100vw - 2 * var(--edge)));
    max-height: 70vh;
    margin: 12vh auto 0;
    background: var(--surface);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    overflow: hidden;
    outline: none;
  }

  /* iOS zooms into a field under 16px. */
  @media (pointer: coarse) {
    .panel {
      font-size: 1rem;
    }
  }

  .grab {
    display: none;
  }

  /* The search above and the footer below are the same height: a control's, plus 4px above and below. */
  .search {
    display: flex;
    align-items: center;
    padding: 0 var(--edge);
    border-bottom: 1px solid var(--line);
  }

  .search input {
    flex: 1;
    min-width: 0;
    padding: calc(var(--control-padding) + 4px) 0;
    border: 0;
    outline: 0;
    background: transparent;
  }

  .search input::placeholder {
    color: var(--faint);
    opacity: 1;
  }

  .rows {
    flex: 1;
    min-height: 0;
    margin: 0;
    list-style: none;
    padding: calc(var(--edge) - var(--inset));
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: var(--line) transparent;
  }

  li {
    position: relative;
    border-radius: var(--radius-small);
    overflow: hidden;
  }

  .behind {
    display: none;
    position: absolute;
    inset: 0;
    align-items: center;
    justify-content: flex-end;
    padding: 0 var(--edge);
    background: var(--danger);
    color: var(--surface);
  }

  li:global([data-swiping]) .behind {
    display: flex;
  }

  /* A row is a control: its height, and its text on the panel's 16px edge (the list's 4px gutter, then 12px). */
  .row {
    position: relative;
    padding: var(--control-padding) var(--inset);
    background: var(--surface);
    cursor: default;
    touch-action: pan-y;
    user-select: none;
    -webkit-user-select: none;
  }

  /* The keyboard's place in the list: a quiet wash. */
  [aria-selected="true"] .row {
    background: color-mix(in srgb, var(--text) 6%, var(--surface));
  }

  /* Pressed: the row answers the finger before the sheet moves. */
  .row:active {
    background: color-mix(in srgb, var(--text) 10%, var(--surface));
  }

  .line {
    display: flex;
    align-items: baseline;
    gap: 2ch;
  }

  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .time {
    flex: none;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .snippet {
    margin-top: var(--pair);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--muted);
  }

  /* Full ink on the wash, even in a grey snippet: a hit is what you're looking for. */
  mark {
    background: var(--highlight);
    color: var(--text);
    border-radius: var(--radius-small);
  }

  .delete {
    display: none;
    flex: none;
    align-self: center;
    width: 24px;
    height: 24px;
    margin: -4px -6px -4px 0;
    border-radius: var(--radius-small);
    color: var(--muted);
  }

  .delete svg {
    width: 16px;
    height: 16px;
    margin: 4px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
  }

  .delete path {
    stroke-width: var(--stroke);
    vector-effect: non-scaling-stroke;
  }

  @media (hover: hover) and (pointer: fine) {
    li:hover .time {
      display: none;
    }

    li:hover .delete {
      display: block;
    }

    .delete:hover {
      color: var(--text);
      background: var(--hover);
    }

    .more:hover,
    .sync:hover {
      color: var(--text);
      background: var(--hover);
    }

    .quiet:hover,
    .danger:hover {
      background: var(--hover);
    }

    .menu button:hover {
      background: var(--hover);
    }
  }

  .sentinel {
    height: 1px;
  }

  /* Where the first row's text would be. */
  .empty {
    margin: 0;
    padding: calc(var(--edge) - var(--inset) + var(--control-padding)) var(--edge);
    color: var(--muted);
  }

  footer {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 2ch;
    padding: 4px 6px 4px var(--edge);
    border-top: 1px solid var(--line);
    color: var(--muted);
  }

  .account {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .sync {
    margin: 0 calc(-1 * var(--inset));
    padding: var(--control-padding) var(--inset);
    border-radius: var(--radius-small);
    color: var(--muted);
    transition:
      color var(--quick) ease,
      background-color var(--quick) ease,
      transform var(--quick) var(--ease-out);
  }

  .menu hr {
    margin: 4px var(--inset);
    border: 0;
    border-top: 1px solid var(--line);
  }

  .menu .danger-item {
    color: var(--danger);
  }

  .ask {
    padding: var(--edge);
  }

  .keys {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--gap) 2ch;
    margin: var(--group) 0 0;
  }

  .keys dd {
    margin: 0;
    color: var(--muted);
  }

  .ask h2 {
    margin: 0;
    font: inherit;
  }

  .ask p {
    margin: var(--gap) 0 0;
    color: var(--muted);
  }

  /* A heading and the line that explains it read as one. */
  .ask h2 + p {
    margin-top: var(--pair);
  }

  .ask .problem {
    color: var(--danger);
  }

  .link {
    text-decoration: underline;
  }

  .choices {
    display: flex;
    justify-content: flex-end;
    gap: var(--gap);
    margin-top: var(--group);
  }

  .choices button {
    min-height: var(--control);
    padding: 0 var(--inset);
    border-radius: var(--radius-small);
    transition:
      transform var(--quick) var(--ease-out),
      background-color var(--quick) ease;
  }

  .choices button:active {
    transform: scale(0.97);
  }

  .quiet {
    border: 1px solid var(--line);
  }

  .danger {
    border: 1px solid var(--danger);
    color: var(--danger);
  }

  .more {
    display: grid;
    place-items: center;
    width: var(--control);
    height: var(--control);
    border-radius: var(--radius-small);
    color: var(--muted);
  }

  .more svg {
    width: 20px;
    height: 20px;
    fill: currentColor;
  }

  .menu {
    position: absolute;
    right: 6px;
    bottom: calc(100% + 2px);
    display: flex;
    flex-direction: column;
    min-width: 180px;
    padding: calc(var(--edge) - var(--inset));
    background: var(--surface);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    transform-origin: bottom right;
    animation: pop var(--brief) var(--ease-out);
  }

  .menu button {
    padding: var(--control-padding) var(--inset);
    border-radius: var(--radius-small);
    text-align: left;
    color: var(--text);
  }

  .menu button:active,
  .more:active,
  .sync:active,
  .delete:active {
    transform: scale(0.97);
  }

  /* Opened by a click or tap: a short rise. Opened by a key: no animation at all. */
  .overlay:global([data-motion]) .panel {
    animation: rise 160ms var(--ease-out);
  }

  .overlay:global([data-motion]) .scrim {
    animation: fade 160ms var(--ease-out);
  }

  .overlay:global([data-closing]) .panel {
    animation: sink var(--quick) var(--ease-out) forwards;
  }

  .overlay:global([data-closing]) .scrim {
    animation: fade var(--quick) var(--ease-out) reverse forwards;
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(4px) scale(0.98);
    }
  }

  @keyframes sink {
    to {
      opacity: 0;
      transform: scale(0.98);
    }
  }

  @keyframes fade {
    from {
      opacity: 0;
    }
  }

  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.97);
    }
  }

  /* On a phone, the panel is a sheet from the bottom. */
  @media (max-width: 640px) {
    .panel {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      width: auto;
      height: calc(100% - env(safe-area-inset-top, 0px) - 12px);
      max-height: none;
      margin: 0;
      padding-bottom: env(safe-area-inset-bottom, 0px);
      border-radius: var(--radius) var(--radius) 0 0;
    }

    .grab {
      display: grid;
      place-items: center;
      height: 20px;
      touch-action: none;
    }

    .grab span {
      width: 36px;
      height: 5px;
      border-radius: var(--radius-small);
      background: var(--line);
    }

    .overlay:global([data-motion]) .panel {
      animation: sheet-in 320ms var(--ease-drawer);
    }

    .overlay:global([data-closing]) .panel {
      animation: sheet-out 220ms var(--ease-drawer) forwards;
    }

    @keyframes sheet-in {
      from {
        transform: translateY(100%);
      }
    }

    @keyframes sheet-out {
      to {
        transform: translateY(100%);
      }
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .menu {
      animation-name: fade;
    }

    .overlay:global([data-motion]) .panel,
    .overlay:global([data-closing]) .panel {
      animation-name: fade;
      animation-duration: 100ms;
    }

    .overlay:global([data-closing]) .panel {
      animation-direction: reverse;
    }
  }
</style>
