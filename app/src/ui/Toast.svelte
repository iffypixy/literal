<script lang="ts">
  import { quintOut } from "svelte/easing";
  import { fade, fly } from "svelte/transition";
  import { act, pause, resume, toasts } from "./toast.svelte.ts";

  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
</script>

<div class="dock" role="status" aria-live="polite">
  {#key toasts.current?.id}
    {#if toasts.current}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="toast"
        in:fly={{ y: calm ? 0 : 8, duration: 180, easing: quintOut }}
        out:fade={{ duration: 150 }}
        onpointerenter={pause}
        onpointerleave={resume}
      >
        <span>{toasts.current.message}</span>
        {#if toasts.current.action}
          {@const { label, shortcut } = toasts.current.action}
          <button onclick={act}
            >{label}{#if shortcut}<kbd>{shortcut}</kbd>{/if}</button
          >
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
    bottom: calc(env(safe-area-inset-bottom, 0px) + 24px);
    display: grid;
    justify-items: center;
    pointer-events: none;
    z-index: 30;
  }

  .toast {
    grid-area: 1 / 1;
    display: flex;
    align-items: center;
    gap: 16px;
    max-width: calc(100vw - 32px);
    box-sizing: border-box;
    padding: 8px 14px;
    border-radius: 0;
    background: var(--text);
    color: var(--bg);
    box-shadow: var(--shadow);
    pointer-events: auto;
  }

  button {
    margin: -10px -8px;
    padding: 10px 8px;
    color: var(--accent-inverse);
    text-decoration: underline;
    transition: transform 120ms var(--ease-out);
  }

  button:active {
    transform: scale(0.96);
  }

  kbd {
    display: inline-block;
    margin-left: 1ch;
    font: inherit;
    opacity: 0.6;
  }
</style>
