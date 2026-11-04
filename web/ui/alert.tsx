import { Show } from "solid-js";

/** What went wrong, read out as it appears; nothing while all is well. */
export function Alert(props: { message: string }) {
  return (
    <Show when={props.message}>
      <p class="error" role="alert">
        {props.message}
      </p>
    </Show>
  );
}
