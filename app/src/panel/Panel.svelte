<script lang="ts">
  import { tick } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { mac, shortcuts } from "../keys.ts";
  import { list, notes, unsynced, type Note } from "../notes/notes.svelte.ts";
  import { describe, markStarts, parse, search, startsWords } from "../notes/search.ts";
  import { account, deleteAccount, signOut } from "../sync/account.svelte.ts";
  import { drain, sync } from "../sync/sync.svelte.ts";
  import { exportAll, importFiles } from "../transfer/transfer.ts";
  import Keys from "../ui/Keys.svelte";
  import { tooltip } from "../ui/tooltip.ts";
  import Back from "./Back.svelte";
  import SignIn from "./SignIn.svelte";

  /** What the panel shows: the notes, signing in, a question before something that can't be undone, the keys, or about. */
  export type View = "notes" | "sign-in" | "sign-out" | "delete" | "keys" | "about";

  /** Something Ctrl+K can do besides opening a note. `pointer`: whether a click (not a key) ran it. */
  type Command = { label: string; keys?: string[]; run: (pointer: boolean) => void };

  type Props = {
    /** The note open behind the panel, if any. */
    current: string | null;
    /** The note open before it: with nothing typed, the list starts there, so Enter goes back to it. */
    previous: string | null;
    /** `pointer` says whether a click (not a key) chose it, which decides if the panel animates away. */
    onpick: (id: string, pointer: boolean) => void;
    ondelete: (id: string) => void;
    /** Starts a new note: the New note command. */
    onnew: () => void;
    /** `pointer`: whether a click or tap closed it, rather than a key. */
    onclose: (pointer: boolean) => void;
    onsignedin: (email: string) => void;
    /** Whether the panel is open: the page behind it goes inert meanwhile. */
    open?: boolean;
  };

  let { current, previous, onpick, ondelete, onnew, onclose, onsignedin, open = $bindable(false) }: Props = $props();

  /** Rows rendered at a time; more appear as the list scrolls. */
  const PAGE = 50;
  /** Letters typed before commands show: with one, they'd come and go with every key, shoving the notes about. */
  const COMMANDS_FROM = 2;
  const touch = matchMedia("(pointer: coarse)");
  // Safari erases a site's storage after 7 days without a visit, unless it's on the Home Screen.
  const fragile =
    /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent) &&
    !matchMedia("(display-mode: standalone)").matches;

  let overlay: HTMLDivElement;
  let input = $state<HTMLInputElement>();
  let rows = $state<HTMLDivElement>();
  let panel: HTMLDivElement;
  let picker = $state<HTMLInputElement>();
  let menuBox = $state<HTMLDivElement>();

  let query = $state("");
  /** The row the arrows are on; -1 until they move. */
  let active = $state(-1);
  let limit = $state(PAGE);
  let now = $state(Date.now());
  let menu = $state(false);
  /** The menu opens upward from its button, or downward when there's no room above. */
  let below = $state(false);
  let view = $state<View>("notes");
  let waiting = $state(0);
  let problem = $state("");
  /** Notes on their way out, whose rows collapse instead of vanishing. */
  let leaving = new Set<string>();
  /** Whether a click or tap closed the panel, rather than a key: what `onclose` is told. */
  let closedByPointer = false;
  /** On screen: open, or still sliding away. The list stays until it's gone. */
  let visible = $state(false);
  /** On a touch screen the sheet is a step in the browser's history, so Back closes it. True while the panel takes that step back itself. */
  let stepping = false;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");

  const keyList: [string[], string][] = [
    [shortcuts.notes, "Notes and commands"],
    [shortcuts.new, "New note"],
    [shortcuts.move, "Choose a note"],
    [shortcuts.open, "Open note"],
    [shortcuts.delete, "Delete note"],
    [shortcuts.undo, "Undo delete"],
    [shortcuts.close, "Close"],
    // Tab types a tab in a note: Esc first lets Tab move on, out of it.
    [["Esc", "Tab"], "Leave the note"],
  ];

  const commands = $derived<Command[]>([
    { label: "New note", keys: shortcuts.new, run: onnew },
    { label: "Import .txt files", run: () => picker?.click() },
    {
      label: "Export all notes",
      run: (pointer) => {
        hide(pointer);
        exportAll();
      },
    },
    account.email ? { label: "Sign out", run: leave } : { label: "Sync across devices", run: () => (view = "sign-in") },
    ...(touch.matches ? [] : [{ label: "Keyboard shortcuts", run: () => (view = "keys") }]),
    { label: "About Literal", run: () => (view = "about") },
  ]);

  const words = $derived(parse(query));
  /** The commands whose words what you type starts; none until you type, so the list opens on your notes. */
  const found = $derived(
    words.join("").length >= COMMANDS_FROM ? commands.filter((command) => startsWords(command.label, words)) : [],
  );
  const results = $derived.by(() => {
    void notes.version;
    return visible ? search(list(), words) : [];
  });
  const shown = $derived(results.slice(0, limit));
  /** Every row in order: the commands, then the notes. */
  const entries = $derived<(Command | Note)[]>([...found, ...shown]);
  /**
   * Where the arrows start. With nothing typed, on the note open before this one (or the latest that isn't this
   * one), so Enter goes back. Typing, on the first note, or the first command if no note matches: so Enter after
   * "new" still opens a note about New York, and Enter after "export" exports.
   */
  const first = $derived.by(() => {
    if (words.length) return results.length ? found.length : 0;
    const back = previous === null ? -1 : results.findIndex((note) => note.id === previous);
    return back >= 0
      ? back
      : Math.max(
          0,
          results.findIndex((note) => note.id !== current),
        );
  });
  const at = $derived(active >= 0 ? active : first);
  const selected = $derived(entries[at]);
  /** On a touch screen no row is highlighted until a key moves the highlight: nothing there could act on it. */
  const highlighted = $derived(!touch.matches || active >= 0);

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
    active = -1;
    delete overlay.dataset.closing;
    panel.style.transform = "";
    panel.style.transition = "";
    if (pointer) overlay.dataset.motion = "";
    else delete overlay.dataset.motion;
    overlay.hidden = false;
    visible = true;
    if (touch.matches) history.pushState({ sheet: true }, "");
    // Once the view is on screen (it may have just changed), within the same task: no keystroke gets lost.
    void tick().then(() => {
      if (rows) rows.scrollTop = 0;
      // Tapped open on a phone, the keyboard would cover the list; the search field is a tap away. Opened by a key,
      // there's a keyboard to type with, even on a tablet.
      if ((pointer && touch.matches) || !input) panel.focus();
      else input.focus();
    });
  }

  /** Closes the panel. `opened`: a note took its place, and with it the sheet's step in history. */
  export function hide(pointer: boolean, opened = false) {
    if (!open) return;
    open = false;
    menu = false;
    closedByPointer = pointer;
    if (!opened) stepBack();
    if (!pointer || reduced.matches) {
      finish();
      return;
    }
    overlay.dataset.closing = "";
    panel.addEventListener("animationend", finish, { once: true });
  }

  /** Whether the last change in history was the panel stepping back by itself, which App leaves alone. */
  export function stepped(): boolean {
    const was = stepping;
    stepping = false;
    return was;
  }

  function stepBack() {
    if (!history.state?.sheet) return;
    stepping = true;
    history.back();
  }

  function finish() {
    // Reopened while closing: the close is off.
    if (open) return;
    panel.style.transform = "";
    panel.style.transition = "";
    overlay.hidden = true;
    visible = false;
    delete overlay.dataset.closing;
    onclose(closedByPointer);
  }

  function pick(entry: Command | Note | undefined, pointer: boolean) {
    if (!entry) return;
    if (isCommand(entry)) return entry.run(pointer);
    // Tapped, the row stays marked while the sheet slides away, so it's clear which note opens.
    if (pointer) active = entries.indexOf(entry);
    onpick(entry.id, pointer);
    hide(pointer, entry.id !== current);
  }

  function isCommand(entry: Command | Note): entry is Command {
    return "run" in entry;
  }

  function rowId(entry: Command | Note): string {
    return isCommand(entry) ? `command-${found.indexOf(entry)}` : `note-${entry.id}`;
  }

  /** Deletes the note. Its row collapses when a click or swipe deleted it; a key just takes it away, like any key. */
  function remove(note: Note | undefined, pointer: boolean) {
    if (!note) return;
    if (pointer) leaving.add(note.id);
    const position = entries.indexOf(note);
    ondelete(note.id);
    void tick().then(() => (active = Math.min(position, Math.max(0, found.length + results.length - 1))));
  }

  /** Moves through the menu's items with the arrow keys. */
  function onmenukeydown(event: KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...(menuBox?.querySelectorAll("button") ?? [])];
    const step = event.key === "ArrowDown" ? 1 : -1;
    const at = items.findIndex((item) => item === document.activeElement);
    items.at(at < 0 ? (step > 0 ? 0 : -1) : (at + step) % items.length)?.focus();
  }

  async function toggleMenu(event: MouseEvent) {
    menu = !menu;
    if (!menu) return;
    below = false;
    await tick();
    below = (menuBox?.getBoundingClientRect().top ?? 0) < 0;
    // Opened by a key (a click no pointer made): the keys go on into the menu.
    if (event.detail === 0) menuBox?.querySelector("button")?.focus();
  }

  function closeMenu() {
    menu = false;
    if (!touch.matches) input?.focus();
  }

  /** In the list, a click leaves the cursor where it was, in the search field: the keys go on working. */
  function keepFocus(event: MouseEvent) {
    if (view === "notes" && !(event.target as Element).closest("input, a")) event.preventDefault();
  }

  function move(by: number) {
    const total = found.length + results.length;
    if (!total) return;
    active = Math.min(total - 1, Math.max(0, at + by));
    if (active - found.length >= limit) limit += PAGE;
    void tick().then(() => rows?.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest" }));
  }

  function oninput() {
    active = -1;
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
    } else if (selected && !isCommand(selected) && deletes(event)) {
      event.preventDefault();
      remove(selected, false);
    }
  }

  /**
   * Whether the key deletes the highlighted note. Delete does, with nothing after the cursor to erase (fn⌫ on a
   * Mac); and on a Mac ⌘⌫, as in Finder, with nothing before it. Not Ctrl+Backspace, which on Windows erases a
   * word of the search. Held down, a key deletes one note, not every note it repeats over.
   */
  function deletes(event: KeyboardEvent): boolean {
    if (!input || event.repeat || event.altKey || event.shiftKey) return false;
    if (input.selectionStart !== input.selectionEnd) return false;
    if (event.key === "Delete") return !event.ctrlKey && !event.metaKey && input.selectionEnd === input.value.length;
    return mac && event.key === "Backspace" && event.metaKey && input.selectionStart === 0;
  }

  /** Esc goes back one step: out of the menu, out of a view, then out of the panel. */
  function onescape(event: KeyboardEvent) {
    if (!open || event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    if (menu) closeMenu();
    else if (view !== "notes") void back();
    else hide(false);
  }

  function onclick(event: MouseEvent) {
    if (menu && !(event.target as Element).closest(".menu, .more")) menu = false;
  }

  /** Rows collapse when their note is deleted, and vanish instantly when a search filters them out. */
  function collapse(node: HTMLElement, id: string) {
    // The mark is used up here, when the row leaves: the delete is saved first, so that's after a tick or two.
    if (!leaving.delete(id) || reduced.matches) return { duration: 0 };
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
      let start: { x: number; y: number; id: number } | null = null;
      let dragging = false;
      let dx = 0;
      const recent = motion();

      function down(event: PointerEvent) {
        // One finger at a time: a second one can't take over the swipe.
        if (event.pointerType !== "touch" || start) return;
        start = { x: event.clientX, y: event.clientY, id: event.pointerId };
        dragging = false;
        dx = 0;
        recent.reset(event.clientX, event.timeStamp);
      }

      function moveTo(event: PointerEvent) {
        if (!start || event.pointerId !== start.id) return;
        dx = event.clientX - start.x;
        recent.add(event.clientX, event.timeStamp);
        const dy = event.clientY - start.y;
        if (!dragging) {
          if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) start = null;
          else if (Math.abs(dx) > 8) {
            dragging = true;
            node.setPointerCapture(event.pointerId);
          }
          return;
        }
        // Left follows the finger, over the red "Delete"; right resists, over nothing.
        node.parentElement?.toggleAttribute("data-swiping", dx < 0);
        const x = dx < 0 ? dx : dx * 0.15;
        node.style.transition = "none";
        node.style.transform = `translateX(${x}px)`;
      }

      function up(event: PointerEvent) {
        if (!start || event.pointerId !== start.id) return;
        start = null;
        if (!dragging) return;
        dragging = false;
        const velocity = -recent.velocity(event.timeStamp);
        node.style.transition = reduced.matches ? "none" : "transform 200ms var(--ease-out)";
        if (-dx > node.offsetWidth * 0.4 || (velocity > 0.5 && dx < -40)) {
          node.style.transform = "translateX(-100%)";
          if (reduced.matches) remove(note, true);
          else node.addEventListener("transitionend", () => remove(note, true), { once: true });
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

  /** Drag the sheet down by its handle to close it, as on any phone; a tap on the handle closes it too. */
  function grab(node: HTMLElement) {
    let start: { y: number; id: number } | null = null;
    let dy = 0;
    const recent = motion();

    function down(event: PointerEvent) {
      // One finger at a time: a second one can't take over the drag.
      if (start) return;
      start = { y: event.clientY, id: event.pointerId };
      dy = 0;
      recent.reset(event.clientY, event.timeStamp);
      node.setPointerCapture(event.pointerId);
      panel.style.transition = "none";
    }

    function moveTo(event: PointerEvent) {
      if (!start || event.pointerId !== start.id) return;
      dy = event.clientY - start.y;
      recent.add(event.clientY, event.timeStamp);
      // Down follows the finger; up resists.
      panel.style.transform = `translateY(${dy > 0 ? dy : dy * 0.1}px)`;
    }

    function up(event: PointerEvent) {
      if (!start || event.pointerId !== start.id) return;
      start = null;
      const velocity = recent.velocity(event.timeStamp);
      panel.style.transition = "transform 240ms var(--ease-drawer)";
      if (dy > 120 || (velocity > 0.5 && dy > 24)) {
        panel.style.transform = "translateY(100%)";
        open = false;
        closedByPointer = true;
        stepBack();
        panel.addEventListener("transitionend", finish, { once: true });
      } else {
        panel.style.transform = "";
      }
    }

    // A drag ends in a click on the handle; only a tap should close it that way.
    function click(event: MouseEvent) {
      if (Math.abs(dy) > 4) event.stopPropagation();
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
  }

  /** How fast a finger moved over its last tenth of a second: a flick at the end counts, a slow start doesn't. */
  function motion() {
    let samples: { at: number; time: number }[] = [];
    return {
      reset(at: number, time: number) {
        samples = [{ at, time }];
      },
      add(at: number, time: number) {
        samples.push({ at, time });
        while (samples.length > 2 && time - (samples[1]?.time ?? time) > 100) samples.shift();
      },
      velocity(now: number): number {
        const first = samples[0];
        const last = samples.at(-1);
        if (!first || !last || first === last) return 0;
        return (last.at - first.at) / Math.max(1, now - first.time);
      },
    };
  }

  function onpicked() {
    if (!picker) return;
    const files = [...(picker.files ?? [])];
    picker.value = "";
    menu = false;
    // The search that found "Import" would hide what was imported.
    query = "";
    active = -1;
    if (files.length) void importFiles(files);
  }

  async function back() {
    view = "notes";
    problem = "";
    await tick();
    if (!touch.matches) input?.focus();
  }

  /** Signs out at once if everything is synced; otherwise asks first. */
  async function leave() {
    menu = false;
    await drain();
    waiting = unsynced();
    if (waiting || sync.status) view = "sign-out";
    else void signOut();
  }

  async function erase() {
    problem = (await deleteAccount()) ?? "";
  }

  // A view other than the list puts the keyboard on its heading, so it's read out and Tab goes on from there.
  $effect(() => {
    if (!open || view === "notes" || view === "sign-in") return;
    void tick().then(() => panel.querySelector<HTMLElement>("#view-title")?.focus());
  });

  function signedIn(email: string) {
    view = "notes";
    hide(true);
    onsignedin(email);
  }

  const minute = 60_000;
  // In English like every other word here, with the clock (12 or 24 hours) this computer uses.
  const hourCycle = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle;
  const clock = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", hourCycle });
  const day = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
  const dayAndYear = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });

  function ago(at: number): string {
    const age = now - at;
    if (age < minute) return "Just now";
    if (age < 60 * minute) return `${Math.floor(age / minute)}m`;
    const date = new Date(at);
    const today = new Date(now);
    if (date.toDateString() === today.toDateString()) return clock.format(date);
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
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
  aria-label={view === "notes" ? "Notes" : undefined}
  aria-labelledby={view === "notes" ? undefined : "view-title"}
  tabindex="-1"
  hidden
  {onclick}
>
  <div class="scrim" onclick={() => hide(true)} aria-hidden="true"></div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="panel" bind:this={panel} tabindex="-1" onmousedown={keepFocus}>
    <button class="grab" aria-label="Close" {@attach grab} onclick={() => hide(true)}><span></span></button>

    {#if view === "sign-in"}
      <SignIn {fragile} onback={back} ondone={signedIn} />
    {:else if view === "sign-out"}
      <div class="ask">
        <h2 id="view-title" tabindex="-1">
          {waiting === 1
            ? "1 note hasn't"
            : waiting
              ? `${waiting.toLocaleString()} notes haven't`
              : "Some notes may not have"} synced yet
        </h2>
        <p>Signing out removes notes from this device. Changes that haven't synced will be lost.</p>
        <div class="choices">
          <button class="quiet" onclick={back}>Cancel</button>
          <button class="danger" onclick={() => void signOut()}>Sign out anyway</button>
        </div>
      </div>
    {:else if view === "keys"}
      <div class="ask">
        <Back onclick={back} />
        <h2 id="view-title" tabindex="-1">Keyboard shortcuts</h2>
        <dl class="keys">
          {#each keyList as [keys, what]}
            <dt><Keys {keys} /></dt>
            <dd>{what}</dd>
          {/each}
        </dl>
      </div>
    {:else if view === "about"}
      <div class="ask">
        <Back onclick={back} />
        <h2 id="view-title" tabindex="-1">Literal</h2>
        <p>Instant notes, on all your devices.</p>
        <p class="section">Made by Ansat<br />Write to <a href="mailto:hello@literal.ink">hello@literal.ink</a></p>
        <p class="section">
          <a href="/terms" target="_blank">Terms</a> · <a href="/privacy" target="_blank">Privacy</a> ·
          <a href="https://github.com/iffypixy/literal" target="_blank">Source</a>
        </p>
      </div>
    {:else if view === "delete"}
      <div class="ask">
        <h2 id="view-title" tabindex="-1">Delete your account and all your notes?</h2>
        <p>
          Your notes will be erased from Literal and this device. This can't be undone.
          <button class="link" onclick={exportAll}>Export your notes</button> first.
        </p>
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
          aria-expanded={entries.length > 0}
          aria-controls="notes-list"
          aria-activedescendant={selected ? rowId(selected) : undefined}
          aria-label="Search notes and commands"
          placeholder="Search…"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          enterkeyhint="go"
        />
      </div>

      <div
        class="rows"
        role="listbox"
        id="notes-list"
        aria-label="Notes and commands"
        bind:this={rows}
        hidden={!entries.length}
        data-highlighted={highlighted ? "" : undefined}
      >
        {#if found.length}
          <div role="group" aria-labelledby="commands-label">
            <div class="group" id="commands-label">Commands</div>
            {#each found as command, index (command.label)}
              <div
                class="option"
                id="command-{index}"
                role="option"
                tabindex="-1"
                aria-selected={index === at}
                onpointermove={(event) => event.pointerType === "mouse" && (active = index)}
              >
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div class="row" onclick={() => pick(command, true)} role="presentation">
                  <div class="line">
                    <span class="title">
                      {#each markStarts(command.label, words) as part}{#if part.hit}<mark>{part.text}</mark
                          >{:else}{part.text}{/if}{/each}
                    </span>
                    {#if command.keys}<Keys keys={command.keys} />{/if}
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
        <div
          role="group"
          aria-labelledby={found.length ? "notes-label" : undefined}
          aria-label={found.length ? undefined : "Notes"}
        >
          {#if found.length && shown.length}<div class="group" id="notes-label">Notes</div>{/if}
          {#each shown as note, position (note.id)}
            {@const index = found.length + position}
            {@const parts = describe(note, words)}
            <div
              class="option"
              id="note-{note.id}"
              role="option"
              tabindex="-1"
              aria-selected={index === at}
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
                    {@attach tooltip("Delete note", shortcuts.delete)}
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
            </div>
          {/each}
          {#if shown.length < results.length}
            <div class="sentinel" aria-hidden="true" {@attach more}></div>
          {/if}
        </div>
      </div>

      <!-- Signed in on a device still waiting for its notes, "No notes yet" would look like they were lost. -->
      {#if notes.ready && !entries.length && (words.length || !account.email || notes.synced)}
        <p class="empty">{words.length ? "No matches" : "No notes yet"}</p>
      {/if}

      <footer>
        {#if account.email}
          <span class="account" title={account.email}>{account.email}</span>
        {:else}
          <button class="sync" onclick={() => (view = "sign-in")}>
            {fragile ? "Sync to keep notes safe" : "Sync across devices"}<span aria-hidden="true">&ensp;→</span>
          </button>
        {/if}
        <button class="more" aria-label="More" aria-expanded={menu} aria-controls="more-menu" onclick={toggleMenu}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="5" cy="10" r="1.25" /><circle cx="10" cy="10" r="1.25" /><circle cx="15" cy="10" r="1.25" />
          </svg>
        </button>
        {#if menu}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="menu" class:below id="more-menu" bind:this={menuBox} onkeydown={onmenukeydown}>
            {#if !touch.matches}
              <button
                onclick={() => {
                  menu = false;
                  view = "keys";
                }}>Keyboard shortcuts</button
              >
            {/if}
            <button
              onclick={() => {
                menu = false;
                view = "about";
              }}>About Literal</button
            >
            <hr />
            <button onclick={() => picker?.click()}>Import .txt files</button>
            <button
              onclick={() => {
                closeMenu();
                exportAll();
              }}>Export all notes</button
            >
            {#if account.email}
              <hr />
              <button onclick={leave}>Sign out</button>
              <button
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
  /*
   * As tall as what's visible: with a phone's keyboard up, the sheet ends above it. It never scrolls: focusing the
   * sheet while it's still below the screen would scroll it into view, and undo its slide up.
   */
  .overlay {
    position: fixed;
    inset: 0 0 auto;
    height: var(--viewport-height, 100dvh);
    overflow: clip;
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
    outline: none;
  }

  /* On a touch screen, the panel's text is the page's size: 16px, which also keeps iOS from zooming into fields. */
  @media (pointer: coarse) {
    .panel {
      font-size: 16px;
    }
  }

  .grab {
    display: none;
  }

  /* Windows High Contrast drops shadows and washes: edges and the highlighted row are drawn in system colors. */
  @media (forced-colors: active) {
    .panel,
    .menu {
      outline: 1px solid CanvasText;
    }

    .rows[data-highlighted] [aria-selected="true"] .row {
      outline: 2px solid Highlight;
      outline-offset: -2px;
    }

    mark {
      background: Mark;
      color: MarkText;
    }
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
    padding: calc(var(--edge) - var(--inset));
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: var(--line) transparent;
  }

  .option {
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

  .option:global([data-swiping]) .behind {
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
  .rows[data-highlighted] [aria-selected="true"] .row {
    background: color-mix(in srgb, var(--text) 6%, var(--surface));
  }

  /* Asked for more contrast, the wash alone (1.13:1) isn't enough to find: the accent's edge marks the row. */
  @media (prefers-contrast: more) {
    .rows[data-highlighted] [aria-selected="true"] .row {
      box-shadow: inset 2px 0 var(--accent);
    }
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
    .option:hover .time {
      display: none;
    }

    .option:hover .delete {
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

  /* Only when commands show: which rows do something, which rows are notes. Each label heads its own rows. */
  .group {
    padding: var(--group) var(--inset) var(--pair);
    color: var(--muted);
  }

  [role="group"]:first-child .group {
    padding-top: var(--gap);
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
    min-height: 0;
    padding: var(--edge);
    overflow-y: auto;
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

  /* Who made it, then the fine print: each a group of its own. */
  .ask .section {
    margin-top: var(--group);
  }

  .ask a {
    color: inherit;
  }

  /* A finger needs more than a line of text to aim at: the links reach 44px tall without moving anything. */
  @media (pointer: coarse) {
    .ask a {
      display: inline-block;
      padding: 12px 0;
      margin: -12px 0;
    }
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

  .menu.below {
    top: calc(100% + 2px);
    bottom: auto;
    transform-origin: top right;
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
      box-sizing: border-box;
      margin: 0;
      padding-bottom: env(safe-area-inset-bottom, 0px);
      border-radius: var(--radius) var(--radius) 0 0;
    }

    /* Drag it down, or tap it, to close. */
    .grab {
      display: grid;
      place-items: center;
      flex: none;
      width: 100%;
      height: var(--control);
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
