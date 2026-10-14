<script lang="ts">
  import { onMount } from "svelte";
  import { app, boot } from "$lib/foundry.svelte";
  import ChatView from "$lib/components/ChatView.svelte";
  import Login from "$lib/components/Login.svelte";
  import RunPanel from "$lib/components/RunPanel.svelte";
  import SettingsView from "$lib/components/SettingsView.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";

  onMount(() => {
    void boot();
  });
</script>

{#if app.phase === "boot"}
  <p class="boot muted">connecting…</p>
{:else if app.phase === "login"}
  <Login />
{:else}
  <div id="app-shell">
    <Sidebar />
    <main class="main">
      {#if app.view === "settings"}
        <SettingsView />
      {:else}
        <ChatView />
      {/if}
    </main>
    {#if app.view === "chat" && app.rightOpen}
      <aside class="right">
        <RunPanel />
      </aside>
    {/if}
    <div class="toasts">
      {#each app.notifications.slice(-3) as n (n.at)}
        <div class="toast">
          <strong>{n.title || "notification"}</strong>
          <p>{n.body}</p>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .boot {
    padding: 24px;
  }

  #app-shell {
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr) auto;
    height: 100vh;
    height: 100dvh;
  }

  .main {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--bg);
    border-left: 1px solid var(--border-soft);
  }

  .main :global(.pane) {
    flex: 1;
  }

  .right {
    min-height: 0;
    min-width: 0;
    width: 440px;
    max-width: 40vw;
    background: var(--bg-side);
    border-left: 1px solid var(--border-soft);
  }

  .right :global(.pane) {
    flex: 1;
    height: 100%;
  }

  @media (max-width: 1080px) {
    .right {
      display: none;
    }
  }

  @media (max-width: 720px) {
    #app-shell {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr;
    }

    .main {
      border-left: none;
    }
  }

  .toasts {
    position: fixed;
    right: 14px;
    bottom: 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 10;
    max-width: 320px;
  }

  .toast {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 12px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  }

  .toast strong {
    display: block;
    font-size: 12.5px;
    margin-bottom: 2px;
  }

  .toast p {
    margin: 0;
    font-size: 12.5px;
    color: var(--fg-dim);
  }
</style>