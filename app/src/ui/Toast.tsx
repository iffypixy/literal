import { createEffect, createSignal, For, on, Show } from "solid-js";
import { Keys } from "./Keys.tsx";
import { act, pause, resume, toasts, type Toast as Message } from "./toast.ts";
import "./Toast.css";

/** The toast, rising in; the one it replaced fades out beneath it. */
export function Toast() {
  const [leaving, setLeaving] = createSignal<Message[]>([]);

  createEffect(
    on(
      () => toasts.current,
      (_, last) => last && setLeaving((all) => [...all, last]),
      { defer: true },
    ),
  );

  return (
    <div class="dock" role="status" aria-live="polite">
      <For each={leaving()}>
        {(toast) => <Card toast={toast} onGone={() => setLeaving((all) => all.filter((one) => one !== toast))} />}
      </For>
      <Show when={toasts.current} keyed>
        {(toast) => <Card toast={toast} />}
      </Show>
    </div>
  );
}

/** With `onGone`, it's on its way out: inert, and gone once it has faded. */
function Card(props: { toast: Message; onGone?: () => void }) {
  return (
    <div
      class="toast"
      classList={{ leaving: Boolean(props.onGone) }}
      inert={Boolean(props.onGone)}
      onPointerEnter={pause}
      onPointerLeave={resume}
      onFocusIn={pause}
      onFocusOut={resume}
      onAnimationEnd={() => props.onGone?.()}
    >
      <span>{props.toast.message}</span>
      <Show when={props.toast.action}>
        {(action) => (
          <span class="action">
            <button onClick={act}>{action().label}</button>
            <Show when={action().keys}>{(keys) => <Keys keys={keys()} />}</Show>
          </span>
        )}
      </Show>
    </div>
  );
}
