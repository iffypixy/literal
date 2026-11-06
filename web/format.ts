/** Numbers and dates in English, like the rest of the app. Only the clock (12 or 24 hours) follows this computer. */

const Minute = 60_000;
const Numbers = new Intl.NumberFormat("en");
const HourCycle = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle;
const Clock = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", hourCycle: HourCycle });
const MonthDay = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const MonthDayYear = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });

export function number(n: number): string {
  return Numbers.format(n);
}

/** Like "1 note" or "2,000 notes". */
export function plural(n: number, word: string): string {
  return `${number(n)} ${word}${n === 1 ? "" : "s"}`;
}

/** How long ago `at` was, as of `now`: "Just now", "5m", "3:20 PM", "Yesterday", "Mar 4", "Mar 4, 2025". */
export function ago(at: number, now: number): string {
  const age = now - at;
  if (age < Minute) return "Just now";
  if (age < 60 * Minute) return `${Math.floor(age / Minute)}m`;
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return Clock.format(date);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  if (date.getFullYear() === today.getFullYear()) return MonthDay.format(date);
  return MonthDayYear.format(date);
}
