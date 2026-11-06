import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { signOut } from "#/web/leave.ts";
import { plural } from "#/web/lib/format.ts";
import * as notes from "#/web/notes.ts";
import { Confirm } from "#/web/palette/confirm.tsx";
import { View } from "#/web/palette/view.tsx";
import { drain, sync } from "#/web/sync.ts";
import { toast } from "#/web/ui/toast.tsx";

/** Signs out at once if every change has synced, and otherwise asks first. */
export function SignOut(props: { onCancel: () => void }) {
  // Notes with changes the server hasn't taken, once counted.
  const [unsent, setUnsent] = createSignal<number>();
  let left = false;

  onCleanup(() => (left = true));
  onMount(() => void start());

  async function start() {
    await drain();
    const count = await notes.unsynced();
    // Gone back meanwhile, which means not to.
    if (left) return;
    if (count || sync.problem) return setUnsent(count);

    const outcome = await signOut();
    if (outcome.ok) return;
    toast(outcome.reason);
    props.onCancel();
  }

  return (
    <Show when={unsent() !== undefined} fallback={<View title="Signing out…" />}>
      <Confirm
        title={notSynced(unsent() ?? 0)}
        action="Sign out anyway"
        busy="Signing out…"
        onConfirm={signOut}
        onCancel={props.onCancel}
      >
        Signing out removes notes from this device. Changes that haven't synced will be lost.
      </Confirm>
    </Show>
  );
}

function notSynced(count: number): string {
  if (!count) return "Some notes may not have synced yet";
  return `${plural(count, "note")} ${count === 1 ? "hasn't" : "haven't"} synced yet`;
}
