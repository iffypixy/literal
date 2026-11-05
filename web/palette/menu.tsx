import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { byPointer } from "#web/device.ts";
import { pressed } from "#web/shortcuts.ts";
import { IconButton } from "#web/ui/icon.tsx";
import "./menu.css";

/** Something to do besides opening a note, from the menu or found as a command. */
export type Action = { label: string; keys?: string; danger?: boolean; run: (pointer: boolean) => void };

type Props = {
  /** Divided by a line between each. */
  groups: Action[][];
  onEscape: () => void;
};

export function Menu(props: Props) {
  let box: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  /** Upward from its button, or downward when there's no room above. */
  const [below, setBelow] = createSignal(false);

  createEffect(() => {
    if (!open()) return;
    // Before the palette's own Esc, which would close more than the menu.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (!pressed(event, "Escape")) return;
      event.preventDefault();
      setOpen(false);
      props.onEscape();
    };
    // The click that opened the menu reaches here too, so a click on its button doesn't count as one outside.
    const onClick = (event: MouseEvent) => {
      if (event.target instanceof Element && !event.target.closest(".menu, .more")) setOpen(false);
    };
    const listening = new AbortController();
    addEventListener("keydown", closeOnEscape, { capture: true, signal: listening.signal });
    addEventListener("click", onClick, { signal: listening.signal });
    onCleanup(() => listening.abort());
  });

  function toggle(event: MouseEvent) {
    if (open()) return setOpen(false);
    // Drawn above first, so it's measured there, and below if it runs off the top.
    setBelow(false);
    setOpen(true);
    setBelow((box?.getBoundingClientRect().top ?? 0) < 0);
    // Opened by a key (a click no pointer made), so the keys go on into the menu.
    if (!byPointer(event)) box?.querySelector("button")?.focus();
  }

  function onKeyDown(event: KeyboardEvent) {
    const step = pressed(event, "ArrowDown") ? 1 : pressed(event, "ArrowUp") ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const items = [...(box?.querySelectorAll("button") ?? [])];
    const at = items.findIndex((item) => item === document.activeElement);
    // Focus is always on an item, since only they can take it in here. `at(-1)` wraps up to the last.
    items.at((at + step) % items.length)?.focus();
  }

  return (
    <>
      <IconButton
        class="more"
        label="More"
        icon="more"
        aria-expanded={open()}
        aria-controls="more-menu"
        onClick={toggle}
      />
      <Show when={open()}>
        <div ref={box} class="menu surface" classList={{ below: below() }} id="more-menu" onKeyDown={onKeyDown}>
          <For each={props.groups}>
            {(group, index) => (
              <>
                <Show when={index() > 0}>
                  <hr />
                </Show>
                <For each={group}>
                  {(action) => (
                    <button
                      class="quiet"
                      classList={{ danger: action.danger }}
                      onClick={(event) => {
                        setOpen(false);
                        action.run(byPointer(event));
                      }}
                    >
                      {action.label}
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}
