import { createEffect, createSignal, For, on, Show } from "solid-js";
import { createMutable } from "solid-js/store";
import { caps } from "../keys.ts";
import "./toast.css";

/** `keys` is the shortcut that also takes the action, shown beside it. */
type Action = { label: string; keys?: string[]; run: () => void };

type Toast = {
  message: string;
  action?: Action;
  /** Runs when the toast goes without its action being taken. */
  onExpire?: () => void;
};

/** One toast at a time: a new one ends the last. */
const shown = createMutable<{ toast: Toast | null }>({ toast: null });
let timer: ReturnType<typeof setTimeout> | undefined;
let remaining = 0;
let since = 0;
let running = false;

document.addEventListener("visibilitychange", () => (document.hidden ? pause() : resume()));

export function toast(message: string, options: Omit<Toast, "message"> = {}) {
  expire();
  shown.toast = { message, ...options };
  remaining = options.action ? 5000 : 4000;
  resume();
}

/** Takes the toast's action, and ends it. */
export function act() {
  end()?.action?.run();
}

/** Ends the toast without its expiry: the next one takes over what it was about. */
export function quiet() {
  end();
}

/** The toast, rising in; the one it replaced fades out beneath it. */
export function Toasts() {
  const [leaving, setLeaving] = createSignal<Toast[]>([]);

  createEffect(
    on(
      () => shown.toast,
      (_, last) => last && setLeaving((all) => [...all, last]),
      { defer: true },
    ),
  );

  return (
    <div class="dock" role="status" aria-live="polite">
      <For each={leaving()}>
        {(toast) => <Card toast={toast} onGone={() => setLeaving((all) => all.filter((one) => one !== toast))} />}
      </For>
      <Show when={shown.toast} keyed>
        {(toast) => <Card toast={toast} />}
      </Show>
    </div>
  );
}

/** With `onGone`, it's on its way out: inert, and gone once it has faded. */
function Card(props: { toast: Toast; onGone?: () => void }) {
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
            <Show when={action().keys}>{(keys) => caps(keys())}</Show>
          </span>
        )}
      </Show>
    </div>
  );
}

function expire() {
  end()?.onExpire?.();
}

function end(): Toast | null {
  const toast = shown.toast;
  clearTimeout(timer);
  running = false;
  shown.toast = null;
  return toast;
}

/** Stops the clock while the pointer is on the toast or the page is hidden: nobody misses an Undo. */
function pause() {
  if (!running) return;
  running = false;
  clearTimeout(timer);
  remaining -= Date.now() - since;
}

function resume() {
  if (running || !shown.toast || document.hidden) return;
  running = true;
  since = Date.now();
  timer = setTimeout(expire, Math.max(remaining, 1000));
}
