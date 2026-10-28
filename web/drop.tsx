import { createSignal, Show } from "solid-js";
import { importFiles } from "./transfer/transfer.ts";
import "./drop.css";

export function Drop() {
  const [dropping, setDropping] = createSignal(false);
  // Every element a drag passes over enters and leaves: only the count says it left the page.
  let depth = 0;

  addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth++;
    setDropping(true);
  });

  addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) setDropping(false);
  });

  addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });

  addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    setDropping(false);
    void importFiles([...(event.dataTransfer?.files ?? [])]);
  });

  return (
    <Show when={dropping()}>
      <div class="drop" aria-hidden="true">
        <p>Drop to import</p>
      </div>
    </Show>
  );
}

function hasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}
