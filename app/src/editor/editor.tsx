import { createEffect, onCleanup } from "solid-js";
import type * as Y from "yjs";
import { composing } from "../keys.ts";
import { bind } from "./binding.ts";

/** Where the cursor was in a note, and how far it was scrolled. */
export type Position = [start: number, end: number, scroll?: number];

export type EditorApi = {
  /** Puts the cursor in the page, at `position` (scrolled back to where it was) or where it was. */
  focus: (position?: Position) => void;
  position: () => Position;
  /** Empties a blank page of whatever was typed into it but never became a note (a few spaces). */
  clear: () => void;
};

type Props = {
  /** The open note's text, or null on a blank page. */
  text: Y.Text | null;
  /** True while another note is on its way: keys mustn't land in this one meanwhile. */
  readonly: boolean;
  /** Called when a blank page gets its first non-space character. */
  onCreate: () => void;
  onType: () => void;
  ref: (editor: EditorApi) => void;
};

export function Editor(props: Props) {
  // Everything here needs the textarea, so it starts once the textarea exists.
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

  // Styled in base.css, which index.html's stand-in page shares: the page looks the same before the app is here.
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
