<script lang="ts">
  import { quintOut } from "svelte/easing";
  import { fade, fly } from "svelte/transition";
  import Keys from "./Keys.svelte";
  import { act, pause, resume, toasts } from "./toast.svelte.ts";

  const calm = matchMedia("(prefers-reduced-motion: reduce)");
</script>

<div class="dock" role="status" aria-live="polite">
  {#key toasts.current?.id}
    {#if toasts.current}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="toast"
        in:fly={{ y: calm.matches ? 0 : 8, duration: 180, easing: quintOut }}
        out:fade={{ duration: 150 }}
        onpointerenter={pause}
        onpointerleave={resume}
        onfocusin={pause}
        onfocusout={resume}
      >
        <span>{toasts.current.message}</span>
        {#if toasts.current.action}
          {@const { label, keys } = toasts.current.action}
          <span class="action">
            <button onclick={act}>{label}</button>
            {#if keys}<Keys {keys} />{/if}
          </span>
        {/if}
      </div>
    {/if}
  {/key}
</div>

<style>
  .dock {
    position: fixed;
    left: 0;
    right: 0;
    bottom: calc(env(safe-area-inset-bottom, 0px) + var(--edge));
    display: grid;
    justify-items: center;
    pointer-events: none;
    z-index: 30;
  }

  /* With the phone's sheet open, it sits above the sheet's footer rather than on it. */
  :global(body:has(.overlay:not([hidden]))) .dock {
    bottom: calc(env(safe-area-inset-bottom, 0px) + var(--control) + 8px + var(--edge));
  }

  @media (min-width: 641px) {
    :global(body:has(.overlay:not([hidden]))) .dock {
      bottom: calc(env(safe-area-inset-bottom, 0px) + var(--edge));
    }
  }

  /* It floats like the panel and the menu, so it looks like them: their surface, corners and shadow. */
  .toast {
    grid-area: 1 / 1;
    display: flex;
    align-items: baseline;
    gap: 2ch;
    max-width: calc(100vw - 2 * var(--edge));
    box-sizing: border-box;
    padding: var(--control-padding) var(--edge);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow);
    pointer-events: auto;
  }

  /*
   * An action inside a line of text: underlined, like every other one in the app. Its target reaches past the
   * word, for a finger, without moving it or swelling its focus ring.
   */
  button {
    position: relative;
    border-radius: var(--radius-small);
    text-decoration: underline;
    transition: transform var(--quick) var(--ease-out);
  }

  button::after {
    content: "";
    position: absolute;
    inset: -12px -10px;
  }

  button:active {
    transform: scale(0.97);
  }

  .action {
    display: inline-flex;
    align-items: baseline;
    gap: 1ch;
  }

  @media (forced-colors: active) {
    .toast {
      outline: 1px solid CanvasText;
    }
  }
</style>
