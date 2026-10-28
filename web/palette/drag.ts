import { reducedMotion } from "../device.ts";

/** Drag the sheet down by its handle to close it, as on any phone; a tap on the handle closes it too. */
export function grab(handle: HTMLElement, sheet: HTMLElement, onDismiss: () => void) {
  let start: { y: number; id: number } | null = null;
  let dy = 0;
  const recent = motion();

  handle.addEventListener("pointerdown", (event) => {
    // One finger at a time: a second one can't take over the drag.
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
    // Down follows the finger; up resists.
    sheet.style.transform = `translateY(${dy > 0 ? dy : dy * 0.1}px)`;
  });

  function up(event: PointerEvent) {
    if (!start || event.pointerId !== start.id) return;
    start = null;
    const velocity = recent.velocity(event.timeStamp);
    sheet.style.transition = "transform 240ms var(--ease-drawer)";
    if (dy > 120 || (velocity > 0.5 && dy > 24)) {
      sheet.style.transform = "translateY(100%)";
      onDismiss();
    } else {
      sheet.style.transform = "";
    }
  }

  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
  // A drag ends in a click on the handle; only a tap should close it that way.
  handle.addEventListener("click", (event) => Math.abs(dy) > 4 && event.stopPropagation(), true);
}

/** Swipe a row left to delete its note: far enough, or fast enough. Touch only; a mouse gets the × button. */
export function swipe(row: HTMLElement, onSwiped: () => void) {
  let start: { x: number; y: number; id: number } | null = null;
  let dragging = false;
  let dx = 0;
  const recent = motion();

  row.addEventListener("pointerdown", (event) => {
    // One finger at a time: a second one can't take over the swipe.
    if (event.pointerType !== "touch" || start) return;
    start = { x: event.clientX, y: event.clientY, id: event.pointerId };
    dragging = false;
    dx = 0;
    recent.reset(event.clientX, event.timeStamp);
  });

  row.addEventListener("pointermove", (event) => {
    if (!start || event.pointerId !== start.id) return;
    dx = event.clientX - start.x;
    recent.add(event.clientX, event.timeStamp);
    const dy = event.clientY - start.y;
    if (!dragging) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) start = null;
      else if (Math.abs(dx) > 8) {
        dragging = true;
        row.setPointerCapture(event.pointerId);
      }
      return;
    }
    // Left follows the finger, over the red "Delete"; right resists, over nothing.
    row.parentElement?.toggleAttribute("data-swiping", dx < 0);
    row.style.transition = "none";
    row.style.transform = `translateX(${dx < 0 ? dx : dx * 0.15}px)`;
  });

  function up(event: PointerEvent) {
    if (!start || event.pointerId !== start.id) return;
    start = null;
    if (!dragging) return;
    dragging = false;
    const velocity = -recent.velocity(event.timeStamp);
    row.style.transition = reducedMotion.matches ? "none" : "transform 200ms var(--ease-out)";
    if (-dx > row.offsetWidth * 0.4 || (velocity > 0.5 && dx < -40)) {
      row.style.transform = "translateX(-100%)";
      if (reducedMotion.matches) onSwiped();
      else row.addEventListener("transitionend", onSwiped, { once: true });
    } else {
      row.style.transform = "";
      row.addEventListener("transitionend", () => row.parentElement?.removeAttribute("data-swiping"), { once: true });
    }
  }

  row.addEventListener("pointerup", up);
  row.addEventListener("pointercancel", up);
  // A swipe ends with a click on the row; it shouldn't open the note.
  row.addEventListener("click", (event) => row.style.transform && event.stopPropagation(), true);
}

/** How fast a finger moved over its last tenth of a second: a flick at the end counts, a slow start doesn't. */
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
      return (last.at - first.at) / Math.max(1, now - first.time);
    },
  };
}
