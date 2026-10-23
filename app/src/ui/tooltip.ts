/**
 * A tooltip naming a button and its shortcut. The first one waits a moment, so passing over a button doesn't
 * flash it; moving on to the next button while one is up shows the next at once. Mouse only: touch has no hover.
 */
export function tooltip(label: string, keys?: string) {
  return (node: HTMLElement) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    function enter() {
      if (!fine.matches) return;
      const instant = performance.now() < warmUntil;
      timer = setTimeout(() => show(node, label, keys, instant), instant ? 0 : DELAY);
    }

    function leave() {
      clearTimeout(timer);
      if (owner === node) hide();
    }

    node.addEventListener("pointerenter", enter);
    node.addEventListener("pointerleave", leave);
    // Pressing the button is the answer; the question can go.
    node.addEventListener("pointerdown", leave);
    return () => {
      leave();
      node.removeEventListener("pointerenter", enter);
      node.removeEventListener("pointerleave", leave);
      node.removeEventListener("pointerdown", leave);
    };
  };
}

const DELAY = 500;
/** How long after one tooltip goes the next still shows at once. */
const WARM = 300;
/** Between the tooltip and its button, and the tooltip and the window's edge. */
const GAP = 6;

const fine = matchMedia("(hover: hover) and (pointer: fine)");
let tip: HTMLElement | null = null;
let owner: HTMLElement | null = null;
let warmUntil = 0;

function show(node: HTMLElement, label: string, keys: string | undefined, instant: boolean) {
  if (!tip) {
    tip = document.body.appendChild(document.createElement("div"));
    tip.className = "tooltip";
    tip.setAttribute("aria-hidden", "true");
    // Typing means the mouse is resting, not asking.
    addEventListener("keydown", hide);
  }
  owner = node;
  tip.replaceChildren(label);
  if (keys) tip.append(Object.assign(document.createElement("kbd"), { textContent: keys }));
  tip.toggleAttribute("data-instant", instant);

  // Under the button, right edges aligned (every button with one sits on the right); above it if there's no room.
  const button = node.getBoundingClientRect();
  const { offsetWidth: width, offsetHeight: height } = tip;
  const below = button.bottom + GAP + height < innerHeight;
  tip.style.top = `${below ? button.bottom + GAP : button.top - GAP - height}px`;
  tip.style.left = `${Math.max(GAP, Math.min(button.right - width, innerWidth - width - GAP))}px`;
  tip.style.transformOrigin = below ? "top right" : "bottom right";
  tip.dataset.open = "";
}

function hide() {
  if (!tip || !owner) return;
  delete tip.dataset.open;
  owner = null;
  warmUntil = performance.now() + WARM;
}
