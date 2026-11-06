import { Show } from "solid-js";
import "#/web/ui/alert.css";

/** What went wrong, read out as it appears. Nothing while all is well. */
export function Alert(props: { message: string | null }) {
  return (
    <Show when={props.message}>
      <p class="alert" role="alert">
        {props.message}
      </p>
    </Show>
  );
}
