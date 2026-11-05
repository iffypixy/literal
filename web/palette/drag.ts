import { reducedMotion } from "#web/device.ts";

/** How fast a flick is, in pixels a second, at the end of a drag. */
const Flick = 500;
/** Pixels the sheet is dragged down to close it, or flicked. */
const SheetAway = { drag: 120, flick: 24 };
/** The share of a row dragged left to delete its note, or the pixels flicked. */
const RowAway = { share: 0.4, flick: 40 };
/** How much a drag the wrong way follows the finger. */
const Resist = { sheet: 0.1, row: 0.15 };
/** Pixels a finger moves on the handle and still taps it. */
const TapSlop = 4;
/** Pixels a finger moves on a row before it's a swipe or a scroll, and no longer a tap. */
const SwipeSlop = 8;

/** Drag the sheet down by its handle to close it, as on any phone. A tap on the handle closes it too. */
export function grab(handle: HTMLElement, sheet: HTMLElement, onDismiss: () => void) {
  let start: { y: number; id: number } | null = null;
  let dy = 0;
  const recent = motion();

  handle.addEventListener("pointerdown", (event) => {
    // One finger at a time, so a second one can't take over the drag.
    if (start) return;
    start = { y: event.clientY, id: event.pointerId };
    dy = 0;
    recent.reset(event.clientY, event.timeStamp);
    handle.setPointerCapture(event.pointerId);
    sheet.style.transition = "none";
  });

  handle.addEventListener("pointermove", (event) => {
    if (!start || event.pointerId !== start.id) return;
    dy = event.clientY - start.y;
    recent.add(event.clientY, event.timeStamp);
    // Down follows the finger, and up resists.
    sheet.style.transform = `translateY(${dy > 0 ? dy : dy * Resist.sheet}px)`;
  });

  function up(event: PointerEvent) {
    if (!start || event.pointerId !== start.id) return;
    start = null;
    const velocity = recent.velocity(event.timeStamp);
    sheet.style.transition = reducedMotion.matches ? "none" : "transform var(--sheet-out) var(--ease-sheet)";
    // A drag the system cancels (a call, a gesture of its own) springs back.
    if (event.type === "pointerup" && (dy > SheetAway.drag || (velocity > Flick && dy > SheetAway.flick))) {
      sheet.style.transform = "translateY(100%)";
      onDismiss();
    } else {
      sheet.style.transform = "";
    }
  }

  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
  // A drag ends in a click on the handle, and only a tap should close it that way.
  handle.addEventListener("click", (event) => Math.abs(dy) > TapSlop && event.stopPropagation(), true);
}

/** Swipe a row left, far or fast enough, to delete its note. Touch only, since a mouse gets the × button. */
export function swipe(row: HTMLElement, onSwiped: () => void) {
  let start: { x: number; y: number; id: number } | null = null;
  let dragging = false;
  let dx = 0;
  const recent = motion();

  row.addEventListener("pointerdown", (event) => {
    // One finger at a time, so a second one can't take over the swipe.
    if (start) return;
    dx = 0;
    if (event.pointerType !== "touch") return;
    start = { x: event.clientX, y: event.clientY, id: event.pointerId };
    dragging = false;
    recent.reset(event.clientX, event.timeStamp);
  });

  row.addEventListener("pointermove", (event) => {
    if (!start || event.pointerId !== start.id) return;
    dx = event.clientX - start.x;
    recent.add(event.clientX, event.timeStamp);
    const dy = event.clientY - start.y;
    if (!dragging) {
      if (Math.abs(dy) > SwipeSlop && Math.abs(dy) > Math.abs(dx)) start = null;
      else if (Math.abs(dx) > SwipeSlop) {
        dragging = true;
        row.setPointerCapture(event.pointerId);
      }
      return;
    }
    // Left follows the finger, over the red "Delete". Right resists, over nothing.
    row.parentElement?.toggleAttribute("data-swiping", dx < 0);
    row.style.transition = "none";
    row.style.transform = `translateX(${dx < 0 ? dx : dx * Resist.row}px)`;
  });

  function up(event: PointerEvent) {
    if (!start || event.pointerId !== start.id) return;
    start = null;
    if (!dragging) return;
    dragging = false;
    const velocity = -recent.velocity(event.timeStamp);
    row.style.transition = reducedMotion.matches ? "none" : "transform var(--sheet-out) var(--ease-out)";
    const swiped =
      event.type === "pointerup" &&
      (-dx > row.offsetWidth * RowAway.share || (velocity > Flick && -dx > RowAway.flick));
    row.style.transform = swiped ? "translateX(-100%)" : "";
    const done = swiped ? onSwiped : () => row.parentElement?.removeAttribute("data-swiping");
    // Without motion, there's no transition to wait for.
    if (reducedMotion.matches) done();
    else row.addEventListener("transitionend", done, { once: true });
  }

  row.addEventListener("pointerup", up);
  row.addEventListener("pointercancel", up);
  // A swipe ends with a click on the row, which shouldn't open the note.
  row.addEventListener("click", (event) => Math.abs(dx) > SwipeSlop && event.stopPropagation(), true);
}

/** How fast a finger moved, in pixels a second, over its last tenth of a second, so a flick at the end counts and a slow start doesn't. */
function motion() {
  let samples: { at: number; time: number }[] = [];
  return {
    reset(at: number, time: number) {
      samples = [{ at, time }];
    },
    add(at: number, time: number) {
      samples.push({ at, time });
      while (samples.length > 2 && time - (samples[1]?.time ?? time) > 100) samples.shift();
    },
    velocity(now: number): number {
      const first = samples[0];
      const last = samples.at(-1);
      if (!first || !last || first === last) return 0;
      return ((last.at - first.at) / Math.max(1, now - first.time)) * 1000;
    },
  };
}
