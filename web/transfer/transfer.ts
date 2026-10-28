import { MaxLength } from "../../protocol.ts";
import { add, list } from "../notes/notes.ts";
import { title } from "../notes/search.ts";
import { toast } from "../ui/toast.tsx";
import { zip, type Entry } from "./zip.ts";

const MaxFiles = 500;
/** A larger file can't hold a note that syncs: UTF-8 takes at most 3 bytes a character, after a 3-byte mark. */
const MaxSize = 3 + 3 * MaxLength;

export function exportAll() {
  if (!list().length) {
    toast("No notes to export");
    return;
  }
  const taken = new Set<string>();
  const entries: Entry[] = list().map((note) => {
    const base = fileName(title(note.text));
    let name = `${base}.txt`;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n}).txt`;
    taken.add(name.toLowerCase());
    return { name, text: note.text, modified: new Date(note.editedAt) };
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(zip(entries));
  link.download = `literal-notes-${new Date().toLocaleDateString("sv")}.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

export async function importFiles(files: File[]) {
  const texts = files.filter((file) => /\.(txt|text|md|markdown)$/i.test(file.name) || file.type === "text/plain");
  if (!texts.length) {
    toast("Only .txt and .md files can be imported");
    return;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let imported = 0;
  for (const file of texts.slice(0, MaxFiles)) {
    if (file.size > MaxSize) continue;
    let text: string;
    try {
      text = decoder.decode(await file.arrayBuffer());
    } catch {
      continue; // not UTF-8: counted as skipped
    }
    text = text.replace(/\r\n?/g, "\n");
    if (!text.trim() || text.length > MaxLength) continue;
    add(text, file.lastModified || Date.now());
    imported++;
  }
  const skipped = files.length - imported;
  const count = (n: number, thing: string) => `${n.toLocaleString()} ${thing}${n === 1 ? "" : "s"}`;
  if (!imported) toast(`Only plain text files up to ${MaxLength.toLocaleString()} characters can be imported`);
  else if (skipped) toast(`Imported ${count(imported, "note")} and skipped ${count(skipped, "file")}`);
  else toast(`Imported ${count(imported, "note")}`);
}

/** Safe as a file name on every system. */
function fileName(title: string): string {
  const safe = title
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return safe || "Untitled";
}
