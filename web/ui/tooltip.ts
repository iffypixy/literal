import { onCleanup } from "solid-js";
import { touch } from "#/web/lib/device.ts";
import { Keys } from "#/web/ui/keys.ts";
import "#/web/ui/tooltip.css";

// The first waits a moment, so passing over a button doesn't flash it.
const DelayMs = 500;
// How long after one tooltip goes the next still shows at once.
const WarmMs = 300;
// Between the tooltip and its button, and the tooltip and the window's edge.
const GapPx = 6;

let tip: HTMLElement | undefined;
let owner: HTMLElement | null = null;
let warmUntil = 0;

/** Names a button and its shortcut, set up from the button's ref so it goes when the button does. */
export function tooltip(node: HTMLElement, label: string, keys: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  function handleEnter() {
    if (touch.matches) return;
    const instant = performance.now() < warmUntil;
    timer = setTimeout(() => show(node, label, keys, instant), instant ? 0 : DelayMs);
  }

  function handleLeave() {
    clearTimeout(timer);
    if (owner === node) hide();
  }

  node.addEventListener("pointerenter", handleEnter);
  node.addEventListener("pointerleave", handleLeave);
  node.addEventListener("pointerdown", handleLeave);
  onCleanup(handleLeave);
}

function show(node: HTMLElement, label: string, keys: string, instant: boolean) {
  if (!tip) {
    tip = document.body.appendChild(document.createElement("div"));
    tip.className = "tooltip surface";
    tip.setAttribute("aria-hidden", "true");
    // Typing means the mouse is resting, not asking.
    addEventListener("keydown", hide);
  }
  owner = node;
  tip.replaceChildren(label, Keys({ keys }));
  tip.toggleAttribute("data-instant", instant);

  // Under the button with right edges aligned (every button with one sits on the right), or above if there's no room.
  const button = node.getBoundingClientRect();
  const { offsetWidth: width, offsetHeight: height } = tip;
  const below = button.bottom + GapPx + height < innerHeight;
  tip.style.top = `${below ? button.bottom + GapPx : button.top - GapPx - height}px`;
  tip.style.left = `${Math.max(GapPx, Math.min(button.right - width, innerWidth - width - GapPx))}px`;
  tip.style.transformOrigin = below ? "top right" : "bottom right";
  tip.dataset.open = "";
}

function hide() {
  if (!tip || !owner) return;
  delete tip.dataset.open;
  owner = null;
  warmUntil = performance.now() + WarmMs;
}
