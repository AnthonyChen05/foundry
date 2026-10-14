<script lang="ts">
  import { app, openRight } from "$lib/foundry.svelte";
  import FilesPane from "$lib/components/FilesPane.svelte";
  import RunTimeline from "$lib/components/RunTimeline.svelte";
  import TermPane from "$lib/components/TermPane.svelte";

  type TabId = "run" | "term" | "files";

  const TABS: [TabId, string][] = [
    ["run", "Run"],
    ["term", "Term"],
    ["files", "Files"],
  ];
</script>

<div class="panel">
  <header class="ptabs">
    {#each TABS as [id, label] (id)}
      <button class:sel={app.rightTab === id} onclick={() => openRight(id)}>{label}</button>
    {/each}
    <div class="spacer"></div>
    <button class="icon-btn" title="Close panel" aria-label="Close panel" onclick={() => (app.rightOpen = false)}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
    </button>
  </header>
  <div class="pbody">
    {#if app.rightTab === "run"}
      <RunTimeline />
    {:else if app.rightTab === "term"}
      <TermPane />
    {:else}
      <FilesPane />
    {/if}
  </div>
</div>

<style>
  .panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .ptabs {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 10px 10px 8px;
    flex: none;
  }

  .ptabs button {
    background: transparent;
    border: none;
    color: var(--fg-dim);
    font-size: 13px;
    font-weight: 600;
    padding: 5px 12px;
    border-radius: 8px;
  }

  .ptabs button:hover {
    color: var(--fg);
  }

  .ptabs button.sel {
    color: var(--fg);
    background: var(--bg-raised);
  }

  .pbody {
    flex: 1;
    min-height: 0;
    display: flex;
  }

  .pbody :global(.pane) {
    flex: 1;
  }
</style>