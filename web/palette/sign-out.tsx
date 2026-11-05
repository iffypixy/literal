import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { plural } from "#web/format.ts";
import { unsynced } from "#web/notes/notes.ts";
import { signOut } from "#web/sync/account.ts";
import { drain, sync } from "#web/sync/sync.ts";
import { toast } from "#web/ui/toast.tsx";
import { Confirm } from "./confirm.tsx";
import { View } from "./view.tsx";

/** Signs out at once if every change has synced, and otherwise asks first. */
export function SignOut(props: { onCancel: () => void }) {
  /** Notes with changes the server hasn't taken, once counted. */
  const [unsent, setUnsent] = createSignal<number | null>(null);
  let left = false;

  onCleanup(() => (left = true));
  onMount(() => void start());

  async function start() {
    await drain();
    const count = await unsynced();
    // Gone back meanwhile, which means not to.
    if (left) return;
    if (count || sync.problem) return setUnsent(count);
    const error = await signOut();
    if (!error) return;
    toast(error);
    props.onCancel();
  }

  return (
    <Show when={unsent() !== null} fallback={<View title="Signing out…" />}>
      <Confirm
        title={notSynced(unsent() ?? 0)}
        action="Sign out anyway"
        busy="Signing out…"
        run={signOut}
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
