import { createSignal, type JSX } from "solid-js";
import { Button } from "#web/ui/button.tsx";
import { Alert, View } from "./view.tsx";
import "./confirm.css";

type Props = {
  title: string;
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
    <View title={props.title}>
      <p>{props.children}</p>
      <Alert message={error()} />
      <div class="choices section">
        <Button onClick={() => props.onCancel()}>Cancel</Button>
        <Button variant="danger" busy={busy() && props.busy} onClick={() => void confirm()}>
          {props.action}
        </Button>
      </div>
    </View>
  );
}
