/** Where a pointer was along one axis, and when. */
export type Sample = { positionPx: number; timeMs: number };

// How far back a flick is measured, so a flick at the end counts and a slow start doesn't.
const WindowMs = 100;

/** The samples worth keeping once `sample` comes: those still inside the window. */
export function withSample(samples: Sample[], sample: Sample): Sample[] {
  return [...samples.filter((kept) => kept.timeMs >= sample.timeMs - WindowMs), sample];
}

/**
 * How fast the pointer moved, in pixels a second, over the last tenth of a second before `now`. A pointer at rest sends
 * nothing, so a pause before a flick doesn't slow it, and a pause before letting go stops it.
 */
export function velocityOf(samples: Sample[], now: number): number {
  const recent = samples.filter((sample) => sample.timeMs >= now - WindowMs);
  const first = recent[0];
  const last = recent.at(-1);
  if (!first || !last || first === last) return 0;
  return ((last.positionPx - first.positionPx) / Math.max(1, now - first.timeMs)) * 1000;
}
