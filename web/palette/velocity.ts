/** Where a pointer was, along one axis, in pixels, and when, in milliseconds. */
export type Sample = { at: number; time: number };

/** How far back a flick is measured, so a flick at the end counts and a slow start doesn't. */
const WindowMs = 100;

/** The samples worth keeping once `sample` comes: those still inside the window. */
export function withSample(samples: Sample[], sample: Sample): Sample[] {
  return [...samples.filter((kept) => kept.time >= sample.time - WindowMs), sample];
}

/**
 * How fast the pointer moved, in pixels a second, over the last tenth of a second before `now`. A pointer at rest sends
 * nothing, so a pause before a flick doesn't slow it, and a pause before letting go stops it.
 */
export function velocityOf(samples: Sample[], now: number): number {
  const recent = samples.filter((sample) => sample.time >= now - WindowMs);
  const first = recent[0];
  const last = recent.at(-1);
  if (!first || !last || first === last) return 0;
  return ((last.at - first.at) / Math.max(1, now - first.time)) * 1000;
}
