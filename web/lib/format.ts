const MinuteMs = 60_000;
const HourMs = 60 * MinuteMs;

const numbers = new Intl.NumberFormat("en");
// English, like the rest of the app, but the clock (12 or 24 hours) follows this computer.
const hourCycle = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle;
const clock = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", hourCycle });
const monthDay = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const monthDayYear = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });

export function number(value: number): string {
  return numbers.format(value);
}

/** Like "1 note" or "2,000 notes". */
export function plural(count: number, word: string): string {
  return `${number(count)} ${word}${count === 1 ? "" : "s"}`;
}

/** Like "Just now", "5m", "3:20 PM", "Yesterday", "Mar 4" or "Mar 4, 2025". */
export function ago(at: number, now: number): string {
  const ageMs = now - at;
  if (ageMs < MinuteMs) return "Just now";
  if (ageMs < HourMs) return `${Math.floor(ageMs / MinuteMs)}m`;

  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return clock.format(date);

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";

  if (date.getFullYear() === today.getFullYear()) return monthDay.format(date);
  return monthDayYear.format(date);
}
