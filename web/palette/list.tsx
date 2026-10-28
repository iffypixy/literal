import { batch, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Fragile, Mac, reducedMotion, touch } from "../device.ts";
import { list, notes, type Note } from "../notes/notes.ts";
import { describe, markStarts, parse, search, startsWords, type Segment } from "../notes/search.ts";
import { composing, Shortcuts } from "../shortcuts.ts";
import { account } from "../sync/account.ts";
import { exportAll, importFiles } from "../transfer/transfer.ts";
import { IconButton } from "../ui/icon.tsx";
import { Keys } from "../ui/keys.ts";
import { swipe } from "./drag.ts";
import { Menu, type Action } from "./menu.tsx";
import type { View } from "./palette.tsx";
import "./list.css";

/** Rows rendered at a time; more appear as the list scrolls. */
const PageSize = 50;
/** Letters typed before commands show: with one, they'd come and go with every key, shoving the notes about. */
const CommandsFrom = 2;

type Props = {
  current: string | null;
  /** With nothing typed, the list starts on it, so Enter goes back to it. */
  previous: string | null;
  /** Whether the search field takes the keyboard as the list opens. */
  focus: boolean;
  /** `pointer`: whether a click or tap (not a key) did it. */
  onPick: (id: string, pointer: boolean) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onView: (view: View) => void;
  onClose: (pointer: boolean) => void;
  onSignOut: () => void;
};

export function List(props: Props) {
  // Set as the list renders, before anything below runs.
  let input!: HTMLInputElement;
  let rows!: HTMLDivElement;
  let picker!: HTMLInputElement;

  const [query, setQuery] = createSignal("");
  /** The row the arrows are on; -1 until they move. */
  const [active, setActive] = createSignal(-1);
  const [limit, setLimit] = createSignal(PageSize);
  /** Notes on their way out: their rows are closing, and can't be picked or deleted again meanwhile. */
  const removing = new Set<string>();
  const now = Date.now();

  const actions = {
    new: { label: "New note", keys: Shortcuts.new, run: () => props.onNew() },
    import: { label: "Import .txt files", run: () => picker.click() },
    export: {
      label: "Export all notes",
      run: (pointer) => {
        props.onClose(pointer);
        exportAll();
      },
    },
    sync: { label: "Sync across devices", run: () => props.onView("sign-in") },
    signOut: { label: "Sign out", run: () => props.onSignOut() },
    deleteAccount: { label: "Delete account", danger: true, run: () => props.onView("delete") },
    keys: { label: "Keyboard shortcuts", run: () => props.onView("keys") },
    about: { label: "About Literal", run: () => props.onView("about") },
  } satisfies Record<string, Action>;

  const commands = createMemo<Action[]>(() => [
    actions.new,
    actions.import,
    actions.export,
    account.email ? actions.signOut : actions.sync,
    ...(touch.matches ? [] : [actions.keys]),
    actions.about,
  ]);
  const menu = (): Action[][] => [
    touch.matches ? [actions.about] : [actions.keys, actions.about],
    [actions.import, actions.export],
    ...(account.email ? [[actions.signOut, actions.deleteAccount]] : []),
  ];

  const words = createMemo(() => parse(query()));
  /** None until you type, so the list opens on your notes. */
  const found = createMemo(() =>
    words().join("").length >= CommandsFrom ? commands().filter((command) => startsWords(command.label, words())) : [],
  );
  const results = createMemo(() => {
    void notes.version;
    return search(list(), words());
  });
  const shown = createMemo(() => results().slice(0, limit()));
  const entries = createMemo<(Action | Note)[]>(() => [...found(), ...shown()]);
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

  onMount(() => props.focus && input.focus());

  function pick(entry: Action | Note | undefined, pointer: boolean) {
    if (!entry) return;
    if (isAction(entry)) return entry.run(pointer);
    if (removing.has(entry.id)) return;
    // Tapped, the row stays marked while the sheet slides away, so it's clear which note opens.
    if (pointer) setActive(entries().indexOf(entry));
    props.onPick(entry.id, pointer);
  }

  /**
   * A click or swipe closes the note's row first: a row has no way out once its note is gone from the list. A key
   * just takes it away, like any key.
   */
  async function remove(note: Note | undefined, row?: HTMLElement) {
    if (!note || removing.has(note.id)) return;
    removing.add(note.id);
    if (row && !reducedMotion.matches) await collapse(row);
    // The highlight stays put: on the next note, or the one before when the last one went.
    setActive(Math.min(entries().indexOf(note), found().length + results().length - 2));
    props.onDelete(note.id);
    removing.delete(note.id);
  }

  function move(by: number) {
    const total = found().length + results().length;
    if (!total) return;
    const next = Math.min(total - 1, Math.max(0, at() + by));
    setActive(next);
    if (next - found().length >= limit()) setLimit(limit() + PageSize);
    rows.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest" });
  }

  function onInput(value: string) {
    batch(() => {
      setQuery(value);
      setActive(-1);
      setLimit(PageSize);
    });
    rows.scrollTop = 0;
  }

  function onKeyDown(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (composing(event)) return;
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
    } else if (entry && !isAction(entry) && deletes(event, event.currentTarget)) {
      event.preventDefault();
      void remove(entry);
    }
  }

  function more(sentinel: HTMLElement) {
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && setLimit(limit() + PageSize), {
      root: rows,
      rootMargin: "200px",
    });
    observer.observe(sentinel);
    onCleanup(() => observer.disconnect());
  }

  function rowId(entry: Action | Note): string {
    return isAction(entry) ? `command-${found().indexOf(entry)}` : `note-${entry.id}`;
  }

  function onPicked(field: HTMLInputElement) {
    const files = [...(field.files ?? [])];
    field.value = "";
    // The search that found "Import" would hide what was imported.
    onInput("");
    if (files.length) void importFiles(files);
  }

  return (
    <div class="list">
      <div class="search">
        <input
          ref={input}
          value={query()}
          onInput={(event) => onInput(event.currentTarget.value)}
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
                      <span class="time">{ago(note.editedAt, now)}</span>
                      <IconButton
                        class="delete"
                        label="Delete note"
                        icon="close"
                        keys={Shortcuts.delete}
                        tabindex="-1"
                        onClick={(event) => {
                          event.stopPropagation();
                          void remove(note, option);
                        }}
                      />
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
            <button class="sync" onClick={() => props.onView("sign-in")}>
              {Fragile ? "Sync to keep notes safe" : "Sync across devices"}
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
        <Menu groups={menu()} onEscape={() => !touch.matches && input.focus()} />
        <input
          ref={picker}
          type="file"
          accept=".txt,.text,.md,.markdown,text/plain,text/markdown"
          multiple
          hidden
          onChange={(event) => onPicked(event.currentTarget)}
        />
      </footer>
    </div>
  );
}

function isAction(entry: Action | Note): entry is Action {
  return "run" in entry;
}

function Marked(props: { parts: Segment[] }) {
  return <For each={props.parts}>{(part) => (part.hit ? <mark>{part.text}</mark> : part.text)}</For>;
}

/**
 * Delete deletes, with nothing after the cursor to erase (fn⌫ on a Mac); and on a Mac ⌘⌫, as in Finder, with nothing
 * before it. Not Ctrl+Backspace, which on Windows erases a word of the search. Held down, a key deletes one note.
 */
function deletes(event: KeyboardEvent, field: HTMLInputElement): boolean {
  if (event.repeat || event.altKey || event.shiftKey) return false;
  if (field.selectionStart !== field.selectionEnd) return false;
  if (event.key === "Delete") return !event.ctrlKey && !event.metaKey && field.selectionEnd === field.value.length;
  return Mac && event.key === "Backspace" && event.metaKey && field.selectionStart === 0;
}

function collapse(row: HTMLElement): Promise<unknown> {
  row.style.pointerEvents = "none";
  return row.animate(
    [
      { height: `${row.offsetHeight}px`, opacity: 1 },
      { opacity: 0, offset: 0.5 },
      { height: "0px", opacity: 0 },
    ],
    { duration: 200, easing: getComputedStyle(row).getPropertyValue("--ease-out").trim(), fill: "forwards" },
  ).finished;
}

const Minute = 60_000;
// In English like every other word here, with the clock (12 or 24 hours) this computer uses.
const hourCycle = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle;
const clock = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", hourCycle });
const day = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const dayAndYear = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });

function ago(at: number, now: number): string {
  const age = now - at;
  if (age < Minute) return "Just now";
  if (age < 60 * Minute) return `${Math.floor(age / Minute)}m`;
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return clock.format(date);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  if (date.getFullYear() === today.getFullYear()) return day.format(date);
  return dayAndYear.format(date);
}
