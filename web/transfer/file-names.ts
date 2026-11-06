/** What systems refuse in a file name, or put to other uses: their separators, wildcards and control characters. */
const Forbidden = /[/\\:*?"<>|\u0000-\u001f]/g;
/** Names Windows keeps for devices, whatever extension follows them. */
const Devices = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** Long enough to tell notes apart in a folder, short enough for any system. */
const MaxLength = 60;

/**
 * Names text files by their notes' titles, one at a time: safe on every system, and each told apart from those before
 * it however a system compares names, ignoring case or how an accent is written.
 */
export function createFileNamer(): (title: string) => string {
  const taken = new Set<string>();
  return (title) => {
    const base = baseOf(title);
    let name = `${base}.txt`;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n}).txt`;
    taken.add(name.toLowerCase());
    return name;
  };
}

function baseOf(title: string): string {
  const safe = title
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .replace(Forbidden, "")
    // A leading dot hides a file.
    .replace(/^[\s.]+/, "")
    .trim();
  // Cut by code point, since half an emoji turns into "�".
  const cut = Array.from(safe).slice(0, MaxLength).join("").trim();
  if (!cut) return "Untitled";
  const [stem = "", ...rest] = cut.split(".");
  return Devices.test(stem.trim()) ? [`${stem}_`, ...rest].join(".") : cut;
}
