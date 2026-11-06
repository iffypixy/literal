import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { inputOf, type Input } from "#/web/lib/device.ts";
import { pressed } from "#/web/lib/keyboard.ts";
import { IconButton } from "#/web/ui/icon.tsx";
import "#/web/palette/menu.css";

/** Something to do besides opening a note, from the menu or found as a command. */
export type Action = { label: string; keys?: string; tone?: ActionTone; run: (input: Input) => void };

type ActionTone = "plain" | "danger";

type Props = {
  /** Divided by a line between each. */
  groups: Action[][];
  onEscape: () => void;
};

const Tone = { plain: "quiet", danger: "quiet danger" } satisfies Record<ActionTone, string>;

export function Menu(props: Props) {
  let box: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  // Upward from its button, or downward when there's no room above.
  const [below, setBelow] = createSignal(false);

  createEffect(() => {
    if (!open()) return;
    // Before the palette's own Esc, which would close more than the menu.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!pressed(event, "Escape")) return;
      event.preventDefault();
      setOpen(false);
      props.onEscape();
    };
    // The click that opened the menu reaches here too, so a click on its button doesn't count as one outside.
    const handleClick = (event: MouseEvent) => {
      if (event.target instanceof Element && !event.target.closest(".menu, .more")) setOpen(false);
    };
    const listening = new AbortController();
    addEventListener("keydown", handleKeyDown, { capture: true, signal: listening.signal });
    addEventListener("click", handleClick, { signal: listening.signal });
    onCleanup(() => listening.abort());
  });

  function handleMoreClick(event: MouseEvent) {
    if (open()) return setOpen(false);
    // Drawn above first, so it's measured there, and below if it runs off the top.
    setBelow(false);
    setOpen(true);
    setBelow((box?.getBoundingClientRect().top ?? 0) < 0);
    // Opened by a key, the keys go on into the menu.
    if (inputOf(event) === "key") box?.querySelector("button")?.focus();
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (pressed(event, "ArrowDown")) focusBy(event, 1);
    else if (pressed(event, "ArrowUp")) focusBy(event, -1);
  }

  function focusBy(event: KeyboardEvent, step: number) {
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
        onClick={handleMoreClick}
      />
      <Show when={open()}>
        <div ref={box} class="menu surface" data-below={below() || undefined} id="more-menu" onKeyDown={handleKeyDown}>
          <For each={props.groups}>
            {(group, index) => (
              <>
                <Show when={index() > 0}>
                  <hr />
                </Show>
                <For each={group}>
                  {(action) => (
                    <button
                      class={Tone[action.tone ?? "plain"]}
                      onClick={(event) => {
                        setOpen(false);
                        action.run(inputOf(event));
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
