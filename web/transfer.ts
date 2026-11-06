import { MaxLength } from "#/protocol.ts";
import { attempt } from "#/web/lib/attempt.ts";
import { createFileNamer } from "#/web/lib/file-names.ts";
import { number, plural } from "#/web/lib/format.ts";
import { zip } from "#/web/lib/zip.ts";
import * as notes from "#/web/notes.ts";
import { title } from "#/web/search.ts";
import { toast } from "#/web/ui/toast.tsx";

const MaxFiles = 500;
// A larger file can't hold a note that syncs, since UTF-8 takes at most 3 bytes a character, after a 3-byte mark.
const MaxFileBytes = 3 + 3 * MaxLength;
// Long enough for the browser to have started the download.
const RevokeAfterMs = 10_000;

export function exportAll() {
  const all = notes.list();
  if (!all.length) {
    toast("No notes to export");
    return;
  }

  const nameOf = createFileNamer();
  const entries = all.map((note) => ({
    name: nameOf(title(note.text)),
    text: note.text,
    modified: new Date(note.editedAt),
  }));

  const link = document.createElement("a");
  link.href = URL.createObjectURL(zip(entries));
  // Swedish writes the date as 2026-11-05, in local time.
  link.download = `literal-notes-${new Date().toLocaleDateString("sv")}.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), RevokeAfterMs);
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
    if (file.size > MaxFileBytes) continue;
    const bytes = await file.arrayBuffer();
    const text = attempt(() => decoder.decode(bytes), undefined)?.replace(/\r\n?/g, "\n");
    // Not UTF-8, blank, or too long to sync, it counts as skipped.
    if (!text?.trim() || text.length > MaxLength) continue;
    // A file dated in the future would sit at the top of the list for good.
    notes.add(text, Math.min(file.lastModified || Date.now(), Date.now()));
    imported++;
  }

  const skipped = files.length - imported;
  if (!imported) toast(`Only plain text files up to ${number(MaxLength)} characters can be imported`);
  else if (skipped) toast(`Imported ${plural(imported, "note")} and skipped ${plural(skipped, "file")}`);
  else toast(`Imported ${plural(imported, "note")}`);
}
