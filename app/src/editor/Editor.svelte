<script module lang="ts">
  /** Where the cursor was in a note, and how far it was scrolled. */
  export type Position = [start: number, end: number, scroll?: number];
</script>

<script lang="ts">
  import { tick } from "svelte";
  import type * as Y from "yjs";
  import { bind } from "./binding.ts";

  type Props = {
    /** The open note's text, or null on a blank page. */
    text: Y.Text | null;
    /** True while another note is on its way: keys mustn't land in this one meanwhile. */
    readonly: boolean;
    /** Called when a blank page gets its first non-space character. */
    oncreate: () => void;
    ontype: () => void;
  };

  let { text, readonly, oncreate, ontype }: Props = $props();
  let area: HTMLTextAreaElement;

  $effect(() => {
    if (text) return bind(area, text);
    area.value = "";
  });

  /** Puts the cursor in the page, at `position` (scrolled back to where it was) or where it was. */
  export async function focus(position?: Position) {
    // After pending updates: the page may still be inert from the panel closing, and inert can't take focus.
    await tick();
    if (!position) {
      area.focus();
      return;
    }
    const [start, end, scroll] = position;
    const length = area.value.length;
    area.focus({ preventScroll: true });
    area.setSelectionRange(Math.min(start, length), Math.min(end, length));
    if (scroll !== undefined) area.scrollTop = scroll;
  }

  export function position(): Position {
    return [area.selectionStart, area.selectionEnd, area.scrollTop];
  }

  /** Empties a blank page of whatever was typed into it but never became a note (a few spaces). */
  export function clear() {
    if (!text) area.value = "";
  }

  function oninput() {
    ontype();
    if (!text && area.value.trim()) oncreate();
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Escape") area.blur();
  }
</script>

<textarea bind:this={area} {oninput} {onkeydown} {readonly} class="page" aria-label="Note" autocapitalize="sentences"
></textarea>

<style>
  .page {
    position: fixed;
    inset: 0 0 auto;
    box-sizing: border-box;
    width: 100%;
    height: var(--viewport-height, 100dvh);
    margin: 0;
    /* Like a .txt file: from the top-left corner, as wide as the window. */
    padding: var(--edge) max(var(--edge), env(safe-area-inset-right, 0px)) 40vh
      max(var(--edge), env(safe-area-inset-left, 0px));
    border: 0;
    outline: 0;
    resize: none;
    background: transparent;
    color: var(--text);
    font: inherit;
    tab-size: 4;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: var(--line) transparent;
  }

  /* On a phone the buttons are always there, so the text starts under them; and iOS zooms into a field under 16px. */
  @media (pointer: coarse) {
    .page {
      padding-top: calc(env(safe-area-inset-top, 0px) + 60px);
      padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 40vh);
      font-size: 1rem;
    }
  }
</style>
