import { createEffect, onCleanup } from "solid-js";
import type * as Y from "yjs";
import * as z from "zod/mini";
import { bind } from "#/web/editor-binding.ts";
import { pressed } from "#/web/lib/keyboard.ts";

/** The selection's start and end, and how far the note was scrolled. */
export const PositionSchema = z.tuple([z.number(), z.number(), z.optional(z.number())]);
export type Position = z.infer<typeof PositionSchema>;

export type EditorApi = {
  /** At `position`, scrolled back to where it was; or where the cursor last was. */
  focus: (position?: Position) => void;
  position: () => Position;
  /** Empties a blank page of what never became a note (a few spaces). */
  clear: () => void;
};

type Props = {
  text: Y.Text | null;
  /** While another note loads, so typing doesn't land in this one. */
  readonly: boolean;
  /** A blank page got its first non-space character. */
  onCreate: () => void;
  ref: (editor: EditorApi) => void;
};

export function Editor(props: Props) {
  function attach(area: HTMLTextAreaElement) {
    createEffect(() => {
      const text = props.text;
      if (!text) return;
      const unbind = bind(area, text);
      // The next note starts on an empty page, since only a blank page's words become the note bound to it.
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
      class="editor viewport scroll"
      aria-label="Note"
      autocapitalize="sentences"
      readOnly={props.readonly}
      onInput={(event) => !props.text && event.currentTarget.value.trim() && props.onCreate()}
      onKeyDown={(event) => pressed(event, "Escape") && event.currentTarget.blur()}
    />
  );
}
