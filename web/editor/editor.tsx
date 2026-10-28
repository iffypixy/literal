import { createEffect, onCleanup } from "solid-js";
import type * as Y from "yjs";
import { composing } from "../keys.ts";
import { bind } from "./binding.ts";

export type Position = [start: number, end: number, scroll?: number];

export type EditorApi = {
  /** At `position`, scrolled back to where it was; or where the cursor last was. */
  focus: (position?: Position) => void;
  position: () => Position;
  /** Empties a blank page of what never became a note (a few spaces). */
  clear: () => void;
};

type Props = {
  text: Y.Text | null;
  /** While another note is on its way: keys mustn't land in this one meanwhile. */
  readonly: boolean;
  /** A blank page got its first non-space character. */
  onCreate: () => void;
  onType: () => void;
  ref: (editor: EditorApi) => void;
};

export function Editor(props: Props) {
  function attach(area: HTMLTextAreaElement) {
    createEffect(() => {
      const text = props.text;
      if (!text) return;
      const unbind = bind(area, text);
      // The next note starts on an empty page: only a blank page's words become the note bound to it.
      onCleanup(() => {
        unbind();
        area.value = "";
      });
    });

    props.ref({
      focus(position) {
        if (!position) return area.focus();
        const [start, end, scroll] = position;
        const length = area.value.length;
        area.focus({ preventScroll: true });
        area.setSelectionRange(Math.min(start, length), Math.min(end, length));
        if (scroll !== undefined) area.scrollTop = scroll;
      },
      position: () => [area.selectionStart, area.selectionEnd, area.scrollTop],
      clear() {
        if (!props.text) area.value = "";
      },
    });
  }

  return (
    <textarea
      ref={attach}
      class="editor"
      aria-label="Note"
      autocapitalize="sentences"
      readOnly={props.readonly}
      onInput={(event) => {
        props.onType();
        if (!props.text && event.currentTarget.value.trim()) props.onCreate();
      }}
      onKeyDown={(event) => event.key === "Escape" && !composing(event) && event.currentTarget.blur()}
    />
  );
}
