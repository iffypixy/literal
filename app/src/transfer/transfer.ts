import { add, list } from "../notes/notes.svelte.ts";
import { title } from "../notes/search.ts";
import { toast } from "../ui/toast.svelte.ts";
import { zip, type Entry } from "./zip.ts";

const MAX_FILES = 500;
const MAX_BYTES = 1024 * 1024;

/** Downloads every note as a .txt file, named after its title, in one .zip. */
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

/** Turns each .txt or .md file into a note, and says how it went. */
export async function importFiles(files: File[]) {
  const texts = files.filter((file) => /\.(txt|text|md|markdown)$/i.test(file.name) || file.type === "text/plain");
  if (!texts.length) {
    toast("Only .txt and .md files can be imported");
    return;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let imported = 0;
  for (const file of texts.slice(0, MAX_FILES)) {
    if (file.size > MAX_BYTES) continue;
    let text: string;
    try {
      text = decoder.decode(await file.arrayBuffer());
    } catch {
      continue; // not UTF-8: counted as skipped below
    }
    if (!text.trim()) continue;
    add(text.replace(/\r\n?/g, "\n"), file.lastModified || Date.now());
    imported++;
  }
  const skipped = texts.length - imported;
  const count = (n: number, thing: string) => `${n.toLocaleString()} ${thing}${n === 1 ? "" : "s"}`;
  if (!imported) toast("Only plain text files under 1 MB can be imported");
  else if (skipped) toast(`Imported ${count(imported, "note")} and skipped ${count(skipped, "file")}`);
  else toast(`Imported ${count(imported, "note")}`);
}

/** A title made safe as a file name on every system. */
function fileName(title: string): string {
  const safe = title
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return safe || "Untitled";
}
