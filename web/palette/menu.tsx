import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { composing } from "../shortcuts.ts";
import { IconButton } from "../ui/icon.tsx";
import "./menu.css";

/** Something to do besides opening a note: from the menu, or found as a command. */
export type Action = { label: string; keys?: string[]; danger?: boolean; run: (pointer: boolean) => void };

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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || composing(event)) return;
      event.preventDefault();
      setOpen(false);
      props.onEscape();
    };
    const onClick = (event: MouseEvent) => {
      if (event.target instanceof Element && !event.target.closest(".menu, .more")) setOpen(false);
    };
    addEventListener("keydown", onKeyDown, true);
    addEventListener("click", onClick);
    onCleanup(() => {
      removeEventListener("keydown", onKeyDown, true);
      removeEventListener("click", onClick);
    });
  });

  function toggle(event: MouseEvent) {
    if (open()) return setOpen(false);
    setBelow(false);
    setOpen(true);
    setBelow((box?.getBoundingClientRect().top ?? 0) < 0);
    // Opened by a key (a click no pointer made): the keys go on into the menu.
    if (event.detail === 0) box?.querySelector("button")?.focus();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...(box?.querySelectorAll("button") ?? [])];
    const step = event.key === "ArrowDown" ? 1 : -1;
    const at = items.findIndex((item) => item === document.activeElement);
    items.at(at < 0 ? (step > 0 ? 0 : -1) : (at + step) % items.length)?.focus();
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
                      classList={{ danger: action.danger }}
                      onClick={(event) => {
                        setOpen(false);
                        action.run(event.detail > 0);
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
