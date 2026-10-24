<script lang="ts">
  import { tick } from "svelte";
  import type * as Y from "yjs";
  import { bind } from "./binding.ts";

  type Props = {
    /** The open note's text, or null on a blank page. */
    text: Y.Text | null;
    /** Called when a blank page gets its first non-space character. */
    oncreate: () => void;
    ontype: () => void;
  };

  let { text, oncreate, ontype }: Props = $props();
  let area: HTMLTextAreaElement;

  $effect(() => {
    if (text) return bind(area, text);
    area.value = "";
  });

  /** Puts the cursor in the page, at `selection` or where it was. */
  export async function focus(selection?: [number, number]) {
    // After pending updates: the page may still be inert from the panel closing, and inert can't take focus.
    await tick();
    if (selection) area.setSelectionRange(...clamp(selection));
    area.focus();
  }

  export function selection(): [number, number] {
    return [area.selectionStart, area.selectionEnd];
  }

  function clamp([start, end]: [number, number]): [number, number] {
    const length = area.value.length;
    return [Math.min(start, length), Math.min(end, length)];
  }

  function oninput() {
    ontype();
    if (!text && area.value.trim()) oncreate();
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Escape") area.blur();
  }
</script>

<textarea bind:this={area} {oninput} {onkeydown} class="page" aria-label="Note" autocapitalize="sentences"></textarea>

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
