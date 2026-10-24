import { batch, createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { mac, shortcuts } from "../keys.ts";
import { list, notes, unsynced, type Note } from "../notes/notes.ts";
import { describe, markStarts, parse, search, startsWords, type Segment } from "../notes/search.ts";
import { account, deleteAccount, signOut } from "../sync/account.ts";
import { drain, sync } from "../sync/sync.ts";
import { exportAll, importFiles } from "../transfer/transfer.ts";
import { Keys } from "../ui/Keys.tsx";
import { tooltip } from "../ui/tooltip.ts";
import { Back } from "./Back.tsx";
import { SignIn } from "./SignIn.tsx";
import "./Panel.css";

/** What the panel shows: the notes, signing in, a question before something that can't be undone, the keys, or about. */
export type View = "notes" | "sign-in" | "sign-out" | "delete" | "keys" | "about";

export type PanelApi = {
  toggle: (pointer: boolean) => void;
  /** Opens the panel, at `start`. Keys open it instantly; a click or tap gets a short animation. */
  show: (pointer: boolean, start?: View) => void;
  /** Closes the panel. `opened`: a note took its place, and with it the sheet's step in history. */
  hide: (pointer: boolean, opened?: boolean) => void;
  /** Whether the last change in history was the panel stepping back by itself, which App leaves alone. */
  stepped: () => boolean;
};

/** Something Ctrl+K can do besides opening a note. `pointer`: whether a click (not a key) ran it. */
type Command = { label: string; keys?: string[]; run: (pointer: boolean) => void };

type Props = {
  /** Whether the panel is open: the page behind it goes inert meanwhile. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The note open behind the panel, if any. */
  current: string | null;
  /** The note open before it: with nothing typed, the list starts there, so Enter goes back to it. */
  previous: string | null;
  /** `pointer` says whether a click (not a key) chose it, which decides if the panel animates away. */
  onPick: (id: string, pointer: boolean) => void;
  onDelete: (id: string) => void;
  /** Starts a new note: the New note command. */
  onNew: () => void;
  /** `pointer`: whether a click or tap closed it, rather than a key. */
  onClose: (pointer: boolean) => void;
  onSignedIn: (email: string) => void;
  ref: (panel: PanelApi) => void;
};

/** Rows rendered at a time; more appear as the list scrolls. */
const PAGE = 50;
/** Letters typed before commands show: with one, they'd come and go with every key, shoving the notes about. */
const COMMANDS_FROM = 2;
const touch = matchMedia("(pointer: coarse)");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
// Safari erases a site's storage after 7 days without a visit, unless it's on the Home Screen.
const fragile =
  /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent) &&
  !matchMedia("(display-mode: standalone)").matches;

const KEY_LIST: [string[], string][] = [
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

export function Panel(props: Props) {
  let overlay!: HTMLDivElement;
  let panel!: HTMLDivElement;
  let input: HTMLInputElement | undefined;
  let rows: HTMLDivElement | undefined;
  let picker: HTMLInputElement | undefined;
  let menuBox: HTMLDivElement | undefined;

  const [query, setQuery] = createSignal("");
  /** The row the arrows are on; -1 until they move. */
  const [active, setActive] = createSignal(-1);
  const [limit, setLimit] = createSignal(PAGE);
  const [now, setNow] = createSignal(Date.now());
  const [menu, setMenu] = createSignal(false);
  /** The menu opens upward from its button, or downward when there's no room above. */
  const [below, setBelow] = createSignal(false);
  const [view, setView] = createSignal<View>("notes");
  const [waiting, setWaiting] = createSignal(0);
  const [problem, setProblem] = createSignal("");
  /** On screen: open, or still sliding away. The list stays until it's gone. */
  const [visible, setVisible] = createSignal(false);
  /** Whether a click or tap closed the panel, rather than a key: what `onClose` is told. */
  let closedByPointer = false;
  /** On a touch screen the sheet is a step in the browser's history, so Back closes it. True while the panel takes that step back itself. */
  let stepping = false;

  const commands = createMemo<Command[]>(() => [
    { label: "New note", keys: shortcuts.new, run: () => props.onNew() },
    { label: "Import .txt files", run: () => picker?.click() },
    {
      label: "Export all notes",
      run: (pointer) => {
        hide(pointer);
        exportAll();
      },
    },
    account.email ? { label: "Sign out", run: leave } : { label: "Sync across devices", run: () => setView("sign-in") },
    ...(touch.matches ? [] : [{ label: "Keyboard shortcuts", run: () => setView("keys") }]),
    { label: "About Literal", run: () => setView("about") },
  ]);

  const words = createMemo(() => parse(query()));
  /** The commands whose words what you type starts; none until you type, so the list opens on your notes. */
  const found = createMemo(() =>
    words().join("").length >= COMMANDS_FROM ? commands().filter((command) => startsWords(command.label, words())) : [],
  );
  const results = createMemo(() => {
    void notes.version;
    return visible() ? search(list(), words()) : [];
  });
  const shown = createMemo(() => results().slice(0, limit()));
  /** Every row in order: the commands, then the notes. */
  const entries = createMemo<(Command | Note)[]>(() => [...found(), ...shown()]);
  /**
   * Where the arrows start. With nothing typed, on the note open before this one (or the latest that isn't this
   * one), so Enter goes back. Typing, on the first note, or the first command if no note matches: so Enter after
   * "new" still opens a note about New York, and Enter after "export" exports.
   */
  const first = createMemo(() => {
    if (words().length) return results().length ? found().length : 0;
    const back = results().findIndex((note) => note.id === props.previous);
    return back >= 0
      ? back
      : Math.max(
          0,
          results().findIndex((note) => note.id !== props.current),
        );
  });
  const at = () => (active() >= 0 ? active() : first());
  const selected = () => entries()[at()];
  const selectedId = () => {
    const entry = selected();
    return entry && rowId(entry);
  };
  /** On a touch screen no row is highlighted until a key moves the highlight: nothing there could act on it. */
  const highlighted = () => !touch.matches || active() >= 0;

  props.ref({ toggle, show, hide, stepped });

  // The panel lives as long as the page, and so does this.
  addEventListener("keydown", onEscape);

  // A view other than the list puts the keyboard on its heading, so it's read out and Tab goes on from there.
  createEffect(() => {
    if (!props.open || view() === "notes" || view() === "sign-in") return;
    panel.querySelector<HTMLElement>("#view-title")?.focus();
  });

  function toggle(pointer: boolean) {
    if (props.open) hide(pointer);
    else show(pointer);
  }

  function show(pointer: boolean, start: View = "notes") {
    if (props.open) return setView(start);
    delete overlay.dataset.closing;
    overlay.toggleAttribute("data-motion", pointer);
    panel.style.transform = "";
    panel.style.transition = "";
    overlay.hidden = false;
    batch(() => {
      props.onOpenChange(true);
      setView(start);
      setQuery("");
      setLimit(PAGE);
      setMenu(false);
      setNow(Date.now());
      setActive(-1);
      setVisible(true);
    });
    if (touch.matches) history.pushState({ sheet: true }, "");
    // Another view puts the cursor where it belongs; failing that, it's on the panel.
    if (start !== "notes") {
      if (!panel.contains(document.activeElement)) panel.focus();
      return;
    }
    if (rows) rows.scrollTop = 0;
    // Tapped open on a phone, the keyboard would cover the list; the search field is a tap away. Opened by a key,
    // there's a keyboard to type with, even on a tablet.
    if (pointer && touch.matches) panel.focus();
    else input?.focus();
  }

  function hide(pointer: boolean, opened = false) {
    if (!props.open) return;
    props.onOpenChange(false);
    setMenu(false);
    closedByPointer = pointer;
    if (!opened) stepBack();
    if (!pointer || reduced.matches) return finish();
    overlay.dataset.closing = "";
    panel.addEventListener("animationend", finish, { once: true });
  }

  function stepped(): boolean {
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
    if (props.open) return;
    panel.style.transform = "";
    panel.style.transition = "";
    overlay.hidden = true;
    delete overlay.dataset.closing;
    setVisible(false);
    props.onClose(closedByPointer);
  }

  function pick(entry: Command | Note | undefined, pointer: boolean) {
    if (!entry) return;
    if (isCommand(entry)) return entry.run(pointer);
    // Tapped, the row stays marked while the sheet slides away, so it's clear which note opens.
    if (pointer) setActive(entries().indexOf(entry));
    props.onPick(entry.id, pointer);
    hide(pointer, entry.id !== props.current);
  }

  function rowId(entry: Command | Note): string {
    return isCommand(entry) ? `command-${found().indexOf(entry)}` : `note-${entry.id}`;
  }

  /** Deletes the note. Its row collapses first when a click or swipe deleted it; a key just takes it away. */
  async function remove(note: Note | undefined, row?: HTMLElement) {
    if (!note) return;
    if (row && !reduced.matches) await collapse(row);
    // The highlight stays put: on the next note, or the one before when the last one went.
    setActive(Math.min(entries().indexOf(note), entries().length - 2));
    props.onDelete(note.id);
  }

  /** Moves through the menu's items with the arrow keys. */
  function onMenuKeyDown(event: KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...(menuBox?.querySelectorAll("button") ?? [])];
    const step = event.key === "ArrowDown" ? 1 : -1;
    const at = items.findIndex((item) => item === document.activeElement);
    items.at(at < 0 ? (step > 0 ? 0 : -1) : (at + step) % items.length)?.focus();
  }

  function toggleMenu(event: MouseEvent) {
    if (menu()) return setMenu(false);
    setBelow(false);
    setMenu(true);
    setBelow((menuBox?.getBoundingClientRect().top ?? 0) < 0);
    // Opened by a key (a click no pointer made): the keys go on into the menu.
    if (event.detail === 0) menuBox?.querySelector("button")?.focus();
  }

  function closeMenu() {
    setMenu(false);
    if (!touch.matches) input?.focus();
  }

  /** From the menu to one of the panel's views. */
  function visit(next: View) {
    setMenu(false);
    setView(next);
  }

  /** In the list, a click leaves the cursor where it was, in the search field: the keys go on working. */
  function keepFocus(event: MouseEvent) {
    if (view() === "notes" && !(event.target as Element).closest("input, a")) event.preventDefault();
  }

  function move(by: number) {
    const total = found().length + results().length;
    if (!total) return;
    const next = Math.min(total - 1, Math.max(0, at() + by));
    setActive(next);
    if (next - found().length >= limit()) setLimit(limit() + PAGE);
    rows?.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest" });
  }

  function onInput(field: HTMLInputElement) {
    batch(() => {
      setQuery(field.value);
      setActive(-1);
      setLimit(PAGE);
    });
    if (rows) rows.scrollTop = 0;
  }

  function onKeyDown(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (event.isComposing) return;
    const entry = selected();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(entry, false);
    } else if (entry && !isCommand(entry) && deletes(event, event.currentTarget)) {
      event.preventDefault();
      void remove(entry);
    }
  }

  /** Esc goes back one step: out of the menu, out of a view, then out of the panel. */
  function onEscape(event: KeyboardEvent) {
    if (!props.open || event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    if (menu()) closeMenu();
    else if (view() !== "notes") back();
    else hide(false);
  }

  function onClick(event: MouseEvent) {
    if (menu() && !(event.target as Element).closest(".menu, .more")) setMenu(false);
  }

  /** Loads the next page of rows when the end of the list scrolls into view. */
  function more(sentinel: HTMLElement) {
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && setLimit(limit() + PAGE), {
      root: rows,
      rootMargin: "200px",
    });
    observer.observe(sentinel);
    onCleanup(() => observer.disconnect());
  }

  /** Drag the sheet down by its handle to close it, as on any phone; a tap on the handle closes it too. */
  function grab(handle: HTMLElement) {
    let start: { y: number; id: number } | null = null;
    let dy = 0;
    const recent = motion();

    handle.addEventListener("pointerdown", (event) => {
      // One finger at a time: a second one can't take over the drag.
      if (start) return;
      start = { y: event.clientY, id: event.pointerId };
      dy = 0;
      recent.reset(event.clientY, event.timeStamp);
      handle.setPointerCapture(event.pointerId);
      panel.style.transition = "none";
    });

    handle.addEventListener("pointermove", (event) => {
      if (!start || event.pointerId !== start.id) return;
      dy = event.clientY - start.y;
      recent.add(event.clientY, event.timeStamp);
      // Down follows the finger; up resists.
      panel.style.transform = `translateY(${dy > 0 ? dy : dy * 0.1}px)`;
    });

    function up(event: PointerEvent) {
      if (!start || event.pointerId !== start.id) return;
      start = null;
      const velocity = recent.velocity(event.timeStamp);
      panel.style.transition = "transform 240ms var(--ease-drawer)";
      if (dy > 120 || (velocity > 0.5 && dy > 24)) {
        panel.style.transform = "translateY(100%)";
        props.onOpenChange(false);
        closedByPointer = true;
        stepBack();
        panel.addEventListener("transitionend", finish, { once: true });
      } else {
        panel.style.transform = "";
      }
    }

    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
    // A drag ends in a click on the handle; only a tap should close it that way.
    handle.addEventListener("click", (event) => Math.abs(dy) > 4 && event.stopPropagation(), true);
  }

  function onPicked(field: HTMLInputElement) {
    const files = [...(field.files ?? [])];
    field.value = "";
    // The search that found "Import" would hide what was imported.
    batch(() => {
      setMenu(false);
      setQuery("");
      setActive(-1);
    });
    if (files.length) void importFiles(files);
  }

  function back() {
    batch(() => {
      setView("notes");
      setProblem("");
    });
    if (!touch.matches) input?.focus();
  }

  /** Signs out at once if everything is synced; otherwise asks first. */
  async function leave() {
    setMenu(false);
    await drain();
    setWaiting(unsynced());
    if (waiting() || sync.status) setView("sign-out");
    else void signOut();
  }

  async function erase() {
    setProblem((await deleteAccount()) ?? "");
  }

  function signedIn(email: string) {
    setView("notes");
    hide(true);
    props.onSignedIn(email);
  }

  return (
    <div
      ref={overlay}
      class="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={view() === "notes" ? "Notes" : undefined}
      aria-labelledby={view() === "notes" ? undefined : "view-title"}
      tabindex="-1"
      hidden
      onClick={onClick}
    >
      <div class="scrim" aria-hidden="true" onClick={() => hide(true)} />
      <div ref={panel} class="panel" tabindex="-1" onMouseDown={keepFocus}>
        <button ref={grab} class="grab" aria-label="Close" onClick={() => hide(true)}>
          <span />
        </button>

        <Switch>
          <Match when={view() === "sign-in"}>
            <SignIn fragile={fragile} onBack={back} onDone={signedIn} />
          </Match>

          <Match when={view() === "sign-out"}>
            <div class="ask">
              <h2 id="view-title" tabindex="-1">
                {waiting() === 1
                  ? "1 note hasn't"
                  : waiting()
                    ? `${waiting().toLocaleString()} notes haven't`
                    : "Some notes may not have"}{" "}
                synced yet
              </h2>
              <p>Signing out removes notes from this device. Changes that haven't synced will be lost.</p>
              <div class="choices">
                <button class="quiet" onClick={back}>
                  Cancel
                </button>
                <button class="danger" onClick={() => void signOut()}>
                  Sign out anyway
                </button>
              </div>
            </div>
          </Match>

          <Match when={view() === "keys"}>
            <div class="ask">
              <Back onClick={back} />
              <h2 id="view-title" tabindex="-1">
                Keyboard shortcuts
              </h2>
              <dl class="shortcuts">
                <For each={KEY_LIST}>
                  {([keys, what]) => (
                    <>
                      <dt>
                        <Keys keys={keys} />
                      </dt>
                      <dd>{what}</dd>
                    </>
                  )}
                </For>
              </dl>
            </div>
          </Match>

          <Match when={view() === "about"}>
            <div class="ask">
              <Back onClick={back} />
              <h2 id="view-title" tabindex="-1">
                Literal
              </h2>
              <p>Instant notes, on all your devices.</p>
              <p class="section">
                Made by Ansat
                <br />
                Write to <a href="mailto:hello@literal.ink">hello@literal.ink</a>
              </p>
              <p class="section">
                <a href="/terms" target="_blank">
                  Terms
                </a>{" "}
                ·{" "}
                <a href="/privacy" target="_blank">
                  Privacy
                </a>{" "}
                ·{" "}
                <a href="https://github.com/iffypixy/literal" target="_blank">
                  Source
                </a>
              </p>
            </div>
          </Match>

          <Match when={view() === "delete"}>
            <div class="ask">
              <h2 id="view-title" tabindex="-1">
                Delete your account and all your notes?
              </h2>
              <p>
                Your notes will be erased from Literal and this device. This can't be undone.{" "}
                <button class="link" onClick={exportAll}>
                  Export your notes
                </button>{" "}
                first.
              </p>
              <Show when={problem()}>
                <p class="problem" role="alert">
                  {problem()}
                </p>
              </Show>
              <div class="choices">
                <button class="quiet" onClick={back}>
                  Cancel
                </button>
                <button class="danger" onClick={erase}>
                  Delete account
                </button>
              </div>
            </div>
          </Match>

          <Match when={view() === "notes"}>
            <div class="search">
              <input
                ref={input}
                value={query()}
                onInput={(event) => onInput(event.currentTarget)}
                onKeyDown={onKeyDown}
                type="text"
                role="combobox"
                aria-expanded={entries().length > 0}
                aria-controls="notes-list"
                aria-activedescendant={selectedId()}
                aria-label="Search notes and commands"
                placeholder="Search…"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                enterkeyhint="go"
              />
            </div>

            <div
              ref={rows}
              class="rows"
              role="listbox"
              id="notes-list"
              aria-label="Notes and commands"
              hidden={!entries().length}
              data-highlighted={highlighted() ? "" : undefined}
            >
              <Show when={found().length}>
                <div role="group" aria-labelledby="commands-label">
                  <div class="group" id="commands-label">
                    Commands
                  </div>
                  <For each={found()}>
                    {(command, index) => (
                      <div
                        class="option"
                        id={`command-${index()}`}
                        role="option"
                        tabindex="-1"
                        aria-selected={index() === at()}
                        onPointerMove={(event) => event.pointerType === "mouse" && setActive(index())}
                      >
                        <div class="row" role="presentation" onClick={() => pick(command, true)}>
                          <div class="line">
                            <span class="title">
                              <Marked parts={markStarts(command.label, words())} />
                            </span>
                            <Show when={command.keys}>{(keys) => <Keys keys={keys()} />}</Show>
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              <div
                role="group"
                aria-labelledby={found().length ? "notes-label" : undefined}
                aria-label={found().length ? undefined : "Notes"}
              >
                <Show when={found().length && shown().length}>
                  <div class="group" id="notes-label">
                    Notes
                  </div>
                </Show>
                <For each={shown()}>
                  {(note, position) => {
                    let option!: HTMLDivElement;
                    const index = () => found().length + position();
                    const parts = createMemo(() => describe(note, words()));
                    return (
                      <div
                        ref={option}
                        class="option"
                        id={`note-${note.id}`}
                        role="option"
                        tabindex="-1"
                        aria-selected={index() === at()}
                        aria-current={note.id === props.current ? "true" : undefined}
                        onPointerMove={(event) => event.pointerType === "mouse" && setActive(index())}
                      >
                        <span class="behind" aria-hidden="true">
                          Delete
                        </span>
                        <div
                          ref={(row) => swipe(row, () => void remove(note, option))}
                          class="row"
                          role="presentation"
                          onClick={() => pick(note, true)}
                        >
                          <div class="line">
                            <span class="title">
                              <Marked parts={parts().title} />
                            </span>
                            <span class="time">{ago(note.editedAt, now())}</span>
                            <button
                              ref={(button) => tooltip(button, "Delete note", shortcuts.delete)}
                              class="delete"
                              aria-label="Delete note"
                              tabindex="-1"
                              onClick={(event) => {
                                event.stopPropagation();
                                void remove(note, option);
                              }}
                            >
                              <svg viewBox="0 0 20 20" aria-hidden="true">
                                <path d="m6 6 8 8M14 6l-8 8" />
                              </svg>
                            </button>
                          </div>
                          <Show when={parts().snippet.some((part) => part.text)}>
                            <div class="snippet">
                              <Marked parts={parts().snippet} />
                            </div>
                          </Show>
                        </div>
                      </div>
                    );
                  }}
                </For>
                <Show when={shown().length < results().length}>
                  <div ref={more} class="sentinel" aria-hidden="true" />
                </Show>
              </div>
            </div>

            {/* Signed in on a device still waiting for its notes, "No notes yet" would look like they were lost. */}
            <Show when={notes.ready && !entries().length && (words().length || !account.email || notes.synced)}>
              <p class="empty">{words().length ? "No matches" : "No notes yet"}</p>
            </Show>

            <footer>
              <Show
                when={account.email}
                fallback={
                  <button class="sync" onClick={() => setView("sign-in")}>
                    {fragile ? "Sync to keep notes safe" : "Sync across devices"}
                    <span aria-hidden="true">&ensp;→</span>
                  </button>
                }
              >
                {(email) => (
                  <span class="account" title={email()}>
                    {email()}
                  </span>
                )}
              </Show>
              <button
                class="more"
                aria-label="More"
                aria-expanded={menu()}
                aria-controls="more-menu"
                onClick={toggleMenu}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <circle cx="5" cy="10" r="1.25" />
                  <circle cx="10" cy="10" r="1.25" />
                  <circle cx="15" cy="10" r="1.25" />
                </svg>
              </button>
              <Show when={menu()}>
                <div ref={menuBox} class="menu" classList={{ below: below() }} id="more-menu" onKeyDown={onMenuKeyDown}>
                  <Show when={!touch.matches}>
                    <button onClick={() => visit("keys")}>Keyboard shortcuts</button>
                  </Show>
                  <button onClick={() => visit("about")}>About Literal</button>
                  <hr />
                  <button onClick={() => picker?.click()}>Import .txt files</button>
                  <button
                    onClick={() => {
                      closeMenu();
                      exportAll();
                    }}
                  >
                    Export all notes
                  </button>
                  <Show when={account.email}>
                    <hr />
                    <button onClick={leave}>Sign out</button>
                    <button class="danger-item" onClick={() => visit("delete")}>
                      Delete account
                    </button>
                  </Show>
                </div>
              </Show>
              <input
                ref={picker}
                type="file"
                accept=".txt,.text,.md,.markdown,text/plain,text/markdown"
                multiple
                hidden
                onChange={(event) => onPicked(event.currentTarget)}
              />
            </footer>
          </Match>
        </Switch>
      </div>
    </div>
  );
}

function isCommand(entry: Command | Note): entry is Command {
  return "run" in entry;
}

/** Text with what the search found marked. */
function Marked(props: { parts: Segment[] }) {
  return <For each={props.parts}>{(part) => (part.hit ? <mark>{part.text}</mark> : part.text)}</For>;
}

/**
 * Whether the key deletes the highlighted note. Delete does, with nothing after the cursor to erase (fn⌫ on a
 * Mac); and on a Mac ⌘⌫, as in Finder, with nothing before it. Not Ctrl+Backspace, which on Windows erases a
 * word of the search. Held down, a key deletes one note, not every note it repeats over.
 */
function deletes(event: KeyboardEvent, field: HTMLInputElement): boolean {
  if (event.repeat || event.altKey || event.shiftKey) return false;
  if (field.selectionStart !== field.selectionEnd) return false;
  if (event.key === "Delete") return !event.ctrlKey && !event.metaKey && field.selectionEnd === field.value.length;
  return mac && event.key === "Backspace" && event.metaKey && field.selectionStart === 0;
}

/** Collapses a deleted note's row: its text goes first, then the gap closes, so the rows below rise into space. */
function collapse(row: HTMLElement): Promise<unknown> {
  row.style.pointerEvents = "none";
  return row.animate(
    [
      { height: `${row.offsetHeight}px`, opacity: 1 },
      { opacity: 0, offset: 0.5 },
      { height: "0px", opacity: 0 },
    ],
    { duration: 200, easing: "cubic-bezier(0.33, 1, 0.68, 1)", fill: "forwards" },
  ).finished;
}

/** Swipe a row left to delete its note: far enough, or fast enough. Touch only; a mouse gets the × button. */
function swipe(row: HTMLElement, onSwiped: () => void) {
  let start: { x: number; y: number; id: number } | null = null;
  let dragging = false;
  let dx = 0;
  const recent = motion();

  row.addEventListener("pointerdown", (event) => {
    // One finger at a time: a second one can't take over the swipe.
    if (event.pointerType !== "touch" || start) return;
    start = { x: event.clientX, y: event.clientY, id: event.pointerId };
    dragging = false;
    dx = 0;
    recent.reset(event.clientX, event.timeStamp);
  });

  row.addEventListener("pointermove", (event) => {
    if (!start || event.pointerId !== start.id) return;
    dx = event.clientX - start.x;
    recent.add(event.clientX, event.timeStamp);
    const dy = event.clientY - start.y;
    if (!dragging) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) start = null;
      else if (Math.abs(dx) > 8) {
        dragging = true;
        row.setPointerCapture(event.pointerId);
      }
      return;
    }
    // Left follows the finger, over the red "Delete"; right resists, over nothing.
    row.parentElement?.toggleAttribute("data-swiping", dx < 0);
    row.style.transition = "none";
    row.style.transform = `translateX(${dx < 0 ? dx : dx * 0.15}px)`;
  });

  function up(event: PointerEvent) {
    if (!start || event.pointerId !== start.id) return;
    start = null;
    if (!dragging) return;
    dragging = false;
    const velocity = -recent.velocity(event.timeStamp);
    row.style.transition = reduced.matches ? "none" : "transform 200ms var(--ease-out)";
    if (-dx > row.offsetWidth * 0.4 || (velocity > 0.5 && dx < -40)) {
      row.style.transform = "translateX(-100%)";
      if (reduced.matches) onSwiped();
      else row.addEventListener("transitionend", onSwiped, { once: true });
    } else {
      row.style.transform = "";
      row.addEventListener("transitionend", () => row.parentElement?.removeAttribute("data-swiping"), { once: true });
    }
  }

  row.addEventListener("pointerup", up);
  row.addEventListener("pointercancel", up);
  // A swipe ends with a click on the row; it shouldn't open the note.
  row.addEventListener("click", (event) => row.style.transform && event.stopPropagation(), true);
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

const MINUTE = 60_000;
// In English like every other word here, with the clock (12 or 24 hours) this computer uses.
const hourCycle = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle;
const clock = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", hourCycle });
const day = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const dayAndYear = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });

function ago(at: number, now: number): string {
  const age = now - at;
  if (age < MINUTE) return "Just now";
  if (age < 60 * MINUTE) return `${Math.floor(age / MINUTE)}m`;
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return clock.format(date);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  if (date.getFullYear() === today.getFullYear()) return day.format(date);
  return dayAndYear.format(date);
}
