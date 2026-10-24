import { For } from "solid-js";

/** A shortcut as key caps, like `Ctrl` `K`. See `.keys` and `kbd` in app.css. */
export function Keys(props: { keys: string[] }) {
  return (
    <span class="keys">
      <For each={props.keys}>{(key) => <kbd>{key}</kbd>}</For>
    </span>
  );
}
