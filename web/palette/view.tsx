import { onMount, Show, type JSX } from "solid-js";
import { IconButton } from "#web/ui/icon.tsx";
import "./view.css";

type Props = {
  title: string;
  /** Shows a Back button that does this. */
  onBack?: () => void;
  class?: string;
  onKeyDown?: (event: KeyboardEvent) => void;
  children?: JSX.Element;
};

/**
 * A view the list leads to. It opens with the keyboard on its heading, so it's read out and Tab goes on from there,
 * unless something in it, like a field, took the keyboard first.
 */
export function View(props: Props) {
  let view!: HTMLDivElement;
  let heading!: HTMLHeadingElement;

  onMount(() => view.contains(document.activeElement) || heading.focus());

  return (
    <div ref={view} class={props.class ? `view scroll ${props.class}` : "view scroll"} onKeyDown={props.onKeyDown}>
      {props.onBack && <IconButton class="back" label="Back" icon="back" onClick={props.onBack} />}
      <h2 ref={heading} id="view-title" tabindex="-1">
        {props.title}
      </h2>
      {props.children}
    </div>
  );
}

/** What went wrong, read out as it appears. Nothing while all is well. */
export function Alert(props: { message: string }) {
  return (
    <Show when={props.message}>
      <p class="error" role="alert">
        {props.message}
      </p>
    </Show>
  );
}
