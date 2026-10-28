import { batch, For, Show } from "solid-js";
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

/** One toast at a time: a new one ends the last, which fades out beneath it. */
const shown = createMutable<{ toast: Toast | null; leaving: Toast[] }>({ toast: null, leaving: [] });
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
  quiet()?.action?.run();
}

/** Ends the toast without its expiry, as the next one takes over what it was about. */
export function quiet(): Toast | null {
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

/** The toast, rising in; the ones it replaced fade out beneath it, each from wherever it was. */
export function Toasts() {
  const cards = () => (shown.toast ? [...shown.leaving, shown.toast] : shown.leaving);

  return (
    <div class="dock" role="status" aria-live="polite">
      <For each={cards()}>
        {(toast) => {
          const gone = () => toast !== shown.toast;
          return (
            <div
              class="toast"
              classList={{ leaving: gone() }}
              inert={gone()}
              onPointerEnter={pause}
              onPointerLeave={resume}
              onFocusIn={pause}
              onFocusOut={resume}
              onTransitionEnd={(event) => {
                if (event.target === event.currentTarget && gone())
                  shown.leaving = shown.leaving.filter((one) => one !== toast);
              }}
            >
              <span>{toast.message}</span>
              <Show when={toast.action}>
                {(action) => (
                  <span class="action">
                    <button class="link" onClick={act}>
                      {action().label}
                    </button>
                    <Show when={action().keys}>{(keys) => caps(keys())}</Show>
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
  quiet()?.onExpire?.();
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
