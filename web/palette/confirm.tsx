import { createSignal, Show, type JSX } from "solid-js";
import { Button } from "../ui/button.tsx";
import "./confirm.css";

type Props = {
  title: JSX.Element;
  children: JSX.Element;
  /** The danger button's label, and its label while it runs. */
  action: string;
  busy: string;
  /** Resolves to a message for the person when it didn't work. */
  run: () => Promise<string | null>;
  onCancel: () => void;
};

export function Confirm(props: Props) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  async function confirm() {
    setBusy(true);
    setError((await props.run()) ?? "");
    setBusy(false);
  }

  return (
    <div class="view">
      <h2 id="view-title" tabindex="-1">
        {props.title}
      </h2>
      <p>{props.children}</p>
      <Show when={error()}>
        <p class="error" role="alert">
          {error()}
        </p>
      </Show>
      <div class="choices">
        <Button variant="quiet" onClick={() => props.onCancel()}>
          Cancel
        </Button>
        <Button variant="danger" busy={busy() && props.busy} onClick={() => void confirm()}>
          {props.action}
        </Button>
      </div>
    </div>
  );
}
