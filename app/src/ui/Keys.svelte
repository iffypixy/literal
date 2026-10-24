<script lang="ts">
  /** A shortcut as key caps, like `Ctrl` `K`. See `kbd` in app.css. */
  let { keys }: { keys: string[] } = $props();
</script>

<span class="keys"
  >{#each keys as key}<kbd>{key}</kbd>{/each}</span
>

<style>
  .keys {
    display: inline-flex;
    gap: 2px;
    white-space: nowrap;
  }
</style>
