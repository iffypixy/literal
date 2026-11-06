import { batch, For, Show } from "solid-js";
import { createMutable } from "solid-js/store";
import { Button } from "./button.tsx";
import { Keys } from "./keys.ts";
import "./toast.css";

/** `keys` is the shortcut that also takes the action, shown beside it. */
type Action = { label: string; keys?: string; run: () => void };

type Toast = {
  message: string;
  action?: Action;
  /** Runs when the toast goes without its action taken. */
  onExpire?: () => void;
};

const Shown = 4000;
const ShownWithAction = 5000;
/** The least time left after a pause, so a toast never vanishes the moment it's back in view. */
const ShownAfterPause = 1000;

/** One toast at a time. A new one ends the last, which fades out beneath it. */
const shown = createMutable<{ toast: Toast | null; leaving: Toast[] }>({ toast: null, leaving: [] });
let timer: ReturnType<typeof setTimeout> | undefined;
let remaining = 0;
let since = 0;
let running = false;

export function toast(message: string, options: Omit<Toast, "message"> = {}) {
  expire();
  shown.toast = { message, ...options };
  remaining = options.action ? ShownWithAction : Shown;
  resume();
}

export function runAction() {
  dismiss()?.action?.run();
}

/** Ends the toast without its expiry, when the next one takes over what it was about. */
export function dismiss(): Toast | null {
  const toast = shown.toast;
  clearTimeout(timer);
  running = false;
  // At once, so its card stays on the page and fades, rather than being made anew.
  batch(() => {
    if (toast) shown.leaving.push(toast);
    shown.toast = null;
  });
  return toast;
}

export function Toasts() {
  document.addEventListener("visibilitychange", () => (document.hidden ? pause() : resume()));
  const cards = () => (shown.toast ? [...shown.leaving, shown.toast] : shown.leaving);

  return (
    <div class="dock viewport" role="status" aria-live="polite">
      <For each={cards()}>
        {(toast) => {
          const gone = () => toast !== shown.toast;
          return (
            <div
              class="toast surface"
              classList={{ leaving: gone() }}
              inert={gone()}
              onPointerEnter={pause}
              onPointerLeave={resume}
              onFocusIn={pause}
              onFocusOut={resume}
              onAnimationEnd={(event) => {
                if (event.target === event.currentTarget && gone())
                  shown.leaving = shown.leaving.filter((one) => one !== toast);
              }}
            >
              <span>{toast.message}</span>
              <Show when={toast.action}>
                {(action) => (
                  <span class="action">
                    <Button variant="link" onClick={runAction}>
                      {action().label}
                    </Button>
                    <Show when={action().keys}>{(keys) => <Keys keys={keys()} />}</Show>
                  </span>
                )}
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}

function expire() {
  dismiss()?.onExpire?.();
}

/** On hover, focus, or a hidden page, so nobody misses an Undo. */
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
  timer = setTimeout(expire, Math.max(remaining, ShownAfterPause));
}
