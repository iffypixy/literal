import { createSignal, type JSX } from "solid-js";
import type { Outcome } from "#/web/account.ts";
import { View } from "#/web/palette/view.tsx";
import { Alert } from "#/web/ui/alert.tsx";
import { Button } from "#/web/ui/button.tsx";
import "#/web/palette/confirm.css";

type Props = {
  title: string;
  children: JSX.Element;
  /** The danger button's label, and its label while it runs. */
  action: string;
  busy: string;
  onConfirm: () => Promise<Outcome>;
  onCancel: () => void;
};

export function Confirm(props: Props) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function confirm() {
    setBusy(true);
    const outcome = await props.onConfirm();
    setError(outcome.ok ? null : outcome.reason);
    setBusy(false);
  }

  return (
    <View title={props.title}>
      <p>{props.children}</p>
      <Alert message={error()} />
      <div class="choices section">
        <Button onClick={() => props.onCancel()}>Cancel</Button>
        <Button variant="danger" busy={busy() ? props.busy : undefined} onClick={() => void confirm()}>
          {props.action}
        </Button>
      </div>
    </View>
  );
}
