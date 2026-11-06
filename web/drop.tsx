import { createSignal, Show } from "solid-js";
import { importFiles } from "#/web/transfer.ts";
import "#/web/drop.css";

export function Drop() {
  // A drag enters and leaves every element it passes over, so only a count tells when it has left the page.
  const [depth, setDepth] = createSignal(0);

  addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDepth(depth() + 1);
  });

  addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    setDepth(Math.max(0, depth() - 1));
  });

  addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });

  addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDepth(0);
    void importFiles([...(event.dataTransfer?.files ?? [])]);
  });

  return (
    <Show when={depth() > 0}>
      <div class="drop" aria-hidden="true">
        <p>Drop to import</p>
      </div>
    </Show>
  );
}

function hasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}
