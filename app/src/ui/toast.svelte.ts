/** One toast at a time: a new one ends the last. */

/** `keys` is the shortcut that also takes the action, shown beside it. */
type Action = { label: string; keys?: string[]; run: () => void };

type Toast = {
  id: number;
  message: string;
  action?: Action;
  /** Runs when the toast goes without its action being taken. */
  onexpire?: () => void;
};

export const toasts = $state<{ current: Toast | null }>({ current: null });

let ids = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let remaining = 0;
let since = 0;
let running = false;

export function toast(message: string, options: { action?: Action; onexpire?: () => void } = {}) {
  expire();
  toasts.current = { id: ++ids, message, ...options };
  remaining = options.action ? 5000 : 4000;
  resume();
}

/** Takes the toast's action, and ends it. */
export function act() {
  const current = end();
  current?.action?.run();
}

export function expire() {
  const current = end();
  current?.onexpire?.();
}

/** Ends the toast without its expiry: the next one takes over what it was about. */
export function quiet() {
  end();
}

function end(): Toast | null {
  const current = toasts.current;
  clearTimeout(timer);
  running = false;
  toasts.current = null;
  return current;
}

/** Stops the clock while the pointer is on the toast or the page is hidden: nobody misses an Undo. */
export function pause() {
  if (!running) return;
  running = false;
  clearTimeout(timer);
  remaining -= Date.now() - since;
}

export function resume() {
  if (running || !toasts.current || document.hidden) return;
  running = true;
  since = Date.now();
  timer = setTimeout(expire, Math.max(remaining, 1000));
}

document.addEventListener("visibilitychange", () => (document.hidden ? pause() : resume()));
