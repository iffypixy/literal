import { batch, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Apple, Fragile, hasKeyboard, reducedMotion, touch } from "#web/device.ts";
import { ago } from "#web/format.ts";
import * as notes from "#web/notes/notes.ts";
import { describe, markStarts, parse, search, startRow, startsWords, type Segment } from "#web/notes/search.ts";
import { pressed, Shortcuts } from "#web/shortcuts.ts";
import { account } from "#web/sync/account.ts";
import { exportAll, importFiles } from "#web/transfer/transfer.ts";
import { IconButton } from "#web/ui/icon.tsx";
import { Keys } from "#web/ui/keys.ts";
import { swipe } from "./drag.ts";
import { Menu, type Action } from "./menu.tsx";
import type { ViewName } from "./palette.tsx";
import "./list.css";

/** Rows rendered at a time; more appear as the list scrolls. */
const PageSize = 50;
/** Letters typed before commands show. With one, they'd come and go with every key, shoving the notes about. */
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
  onBlank: () => void;
  onView: (view: ViewName) => void;
  close: (pointer: boolean) => void;
};

export function List(props: Props) {
  let input!: HTMLInputElement;
  let rows!: HTMLDivElement;
  let picker!: HTMLInputElement;

  const [query, setQuery] = createSignal("");
  /** The row the arrows are on; -1 until they move. */
  const [active, setActive] = createSignal(-1);
  const [limit, setLimit] = createSignal(PageSize);
  /** Notes on their way out. Their rows are closing, and can't be picked or deleted again meanwhile. */
  const removing = new Set<string>();
  const now = Date.now();

  const actions = {
    new: { label: "New note", keys: Shortcuts.new, run: () => props.onBlank() },
    import: { label: "Import text files", run: () => picker.click() },
    export: {
      label: "Export all notes",
      run: (pointer) => {
        props.close(pointer);
        exportAll();
      },
    },
    sync: { label: "Sync across devices", run: () => props.onView("sign-in") },
    signOut: { label: "Sign out", run: () => props.onView("sign-out") },
    deleteAccount: { label: "Delete account", danger: true, run: () => props.onView("delete") },
    shortcuts: { label: "Keyboard shortcuts", run: () => props.onView("shortcuts") },
    about: { label: "About Literal", run: () => props.onView("about") },
  } satisfies Record<string, Action>;

  const commands = (): Action[] => [
    actions.new,
    actions.import,
    actions.export,
    account.email ? actions.signOut : actions.sync,
    ...(touch.matches ? [] : [actions.shortcuts]),
    actions.about,
  ];
  const menu = (): Action[][] => [
    touch.matches ? [actions.about] : [actions.shortcuts, actions.about],
    [actions.import, actions.export],
    ...(account.email ? [[actions.signOut, actions.deleteAccount]] : []),
  ];

  const words = createMemo(() => parse(query()));
  /** None until you type, so the list opens on your notes. */
  const commandsFound = createMemo(() =>
    words().join("").length >= CommandsFrom ? commands().filter((command) => startsWords(command.label, words())) : [],
  );
  const results = createMemo(() => search(notes.list(), words()));
  const total = () => commandsFound().length + results().length;
  const first = createMemo(() =>
    startRow(results(), {
      commands: commandsFound().length,
      typed: words().length > 0,
      previous: props.previous,
      current: props.current,
    }),
  );
  /** A page at a time, and always as far as the row the arrows start on, however old its note. */
  const shown = createMemo(() => results().slice(0, Math.max(limit(), first() + 1)));
  const entries = createMemo<(Action | notes.Note)[]>(() => [...commandsFound(), ...shown()]);
  const at = () => (active() >= 0 ? active() : first());
  const selected = () => entries()[at()];
  /** Opened by a tap, no row is highlighted until a key moves the highlight, since nothing there could act on it. */
  const highlighted = () => props.focus || active() >= 0;

  onMount(() => {
    if (!props.focus) return;
    input.focus();
    reveal();
  });

  function pick(entry: Action | notes.Note | undefined, pointer: boolean) {
    if (!entry) return;
    if (isAction(entry)) return entry.run(pointer);
    if (removing.has(entry.id)) return;
    // Tapped, the row stays marked while the sheet slides away, so it's clear which note opens.
    if (pointer) setActive(entries().indexOf(entry));
    props.onPick(entry.id, pointer);
  }

  /**
   * A click or swipe folds the note's row away first, since once the note leaves the list its row is gone at once. A
   * key deletes straight away, like any key.
   */
  async function remove(note: notes.Note | undefined, row?: HTMLElement) {
    if (!note || removing.has(note.id)) return;
    removing.add(note.id);
    if (row && !reducedMotion.matches) await collapse(row);
    // The highlight stays put, on the next note, or the one before if the last one went.
    setActive(Math.min(entries().indexOf(note), total() - 2));
    props.onDelete(note.id);
    removing.delete(note.id);
  }

  function move(by: number) {
    if (!total()) return;
    const next = Math.min(total() - 1, Math.max(0, at() + by));
    setActive(next);
    if (next - commandsFound().length >= shown().length) more();
    reveal();
  }

  function more() {
    setLimit(shown().length + PageSize);
  }

  function reveal() {
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
    const entry = selected();
    if (pressed(event, "ArrowDown")) move(1);
    else if (pressed(event, "ArrowUp")) move(-1);
    else if (pressed(event, "Enter")) pick(entry, false);
    else if (highlighted() && entry && !isAction(entry) && deletes(event, event.currentTarget)) void remove(entry);
    else return;
    event.preventDefault();
  }

  function growWhenNear(sentinel: HTMLElement) {
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && more(), {
      root: rows,
      rootMargin: "200px",
    });
    observer.observe(sentinel);
    onCleanup(() => observer.disconnect());
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
          aria-activedescendant={selected() && `option-${at()}`}
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
        class="rows scroll"
        role="listbox"
        id="notes-list"
        aria-label="Notes and commands"
        hidden={!entries().length}
        data-highlighted={highlighted() ? "" : undefined}
      >
        <Show when={commandsFound().length}>
          <div role="group" aria-label="Commands">
            <div class="group">Commands</div>
            <For each={commandsFound()}>
              {(command, index) => (
                <Option
                  id={`option-${index()}`}
                  selected={index() === at()}
                  onHover={() => setActive(index())}
                  onPick={() => pick(command, true)}
                >
                  <div class="line">
                    <span class="title truncate">
                      <Marked parts={markStarts(command.label, words())} />
                    </span>
                    <Show when={command.keys}>{(keys) => <Keys keys={keys()} />}</Show>
                  </div>
                </Option>
              )}
            </For>
          </div>
        </Show>
        <div role="group" aria-label="Notes">
          <Show when={commandsFound().length && shown().length}>
            <div class="group">Notes</div>
          </Show>
          <For each={shown()}>
            {(note, position) => {
              let option!: HTMLDivElement;
              const index = () => commandsFound().length + position();
              const parts = createMemo(() => describe(note, words()));
              return (
                <Option
                  ref={option}
                  id={`option-${index()}`}
                  selected={index() === at()}
                  current={note.id === props.current}
                  onHover={() => setActive(index())}
                  onPick={() => pick(note, true)}
                  onSwipe={() => void remove(note, option)}
                >
                  <div class="line">
                    <span class="title truncate">
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
                  <Show when={parts().snippet.length}>
                    <div class="snippet truncate">
                      <Marked parts={parts().snippet} />
                    </div>
                  </Show>
                </Option>
              );
            }}
          </For>
          <Show when={shown().length < results().length}>
            <div ref={growWhenNear} class="sentinel" aria-hidden="true" />
          </Show>
        </div>
      </div>

      {/* Signed in on a device still waiting for its notes, "No notes yet" would look like they were lost. */}
      <Show
        when={notes.library.ready && !entries().length && (words().length || !account.email || notes.library.synced)}
      >
        <p class="empty">{words().length ? "No matches" : "No notes yet"}</p>
      </Show>

      <footer>
        <Show
          when={account.email}
          fallback={
            <button class="sync quiet" onClick={() => props.onView("sign-in")}>
              {Fragile ? "Sync to keep notes safe" : "Sync across devices"}
              <span aria-hidden="true">&ensp;→</span>
            </button>
          }
        >
          {(email) => (
            <span class="account truncate" title={email()}>
              {email()}
            </span>
          )}
        </Show>
        <Menu groups={menu()} onEscape={() => hasKeyboard() && input.focus()} />
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

/** A row the arrows can land on. With `onSwipe`, it's a note's row, which a swipe to the left deletes. */
function Option(props: {
  ref?: HTMLDivElement | ((option: HTMLDivElement) => void);
  id: string;
  selected: boolean;
  current?: boolean;
  onHover: () => void;
  onPick: () => void;
  onSwipe?: () => void;
  children: JSX.Element;
}) {
  return (
    <div
      ref={props.ref}
      class="option"
      id={props.id}
      role="option"
      tabindex="-1"
      aria-selected={props.selected}
      aria-current={props.current ? "true" : undefined}
      onPointerMove={(event) => event.pointerType === "mouse" && props.onHover()}
    >
      <Show when={props.onSwipe}>
        <span class="behind" aria-hidden="true">
          Delete
        </span>
      </Show>
      <div
        ref={(row) => props.onSwipe && swipe(row, props.onSwipe)}
        class="row"
        role="presentation"
        onClick={() => props.onPick()}
      >
        {props.children}
      </div>
    </div>
  );
}

function isAction(entry: Action | notes.Note): entry is Action {
  return "run" in entry;
}

function Marked(props: { parts: Segment[] }) {
  return <For each={props.parts}>{(part) => (part.hit ? <mark>{part.text}</mark> : part.text)}</For>;
}

/**
 * Delete deletes when there's nothing after the cursor to erase (fn⌫ on a Mac), and on Apple devices so does ⌘⌫, as
 * in Finder, when there's nothing before it. Not Ctrl+Backspace, which on Windows erases a word of the search. Held
 * down, a key deletes just one note.
 */
function deletes(event: KeyboardEvent, field: HTMLInputElement): boolean {
  if (event.repeat || field.selectionStart !== field.selectionEnd) return false;
  if (pressed(event, "Delete")) return field.selectionEnd === field.value.length;
  return Apple && pressed(event, "Mod+Backspace") && field.selectionStart === 0;
}

function collapse(row: HTMLElement): Promise<unknown> {
  row.style.pointerEvents = "none";
  const style = getComputedStyle(row);
  return row.animate(
    [
      { height: `${row.offsetHeight}px`, opacity: 1 },
      { opacity: 0, offset: 0.5 },
      { height: "0px", opacity: 0 },
    ],
    {
      duration: parseFloat(style.getPropertyValue("--fade")),
      easing: style.getPropertyValue("--ease-out").trim(),
      fill: "forwards",
    },
  ).finished;
}
