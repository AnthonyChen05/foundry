<script lang="ts">
  import { createChat, logout, selectChat, setView, app } from "$lib/foundry.svelte";

  let creating = $state(false);
  let searchOpen = $state(false);
  let query = $state("");
  let searching = $state<HTMLInputElement | undefined>(undefined);

  async function newChat(): Promise<void> {
    if (creating) return;
    creating = true;
    try {
      await createChat();
      setView("chat");
    } finally {
      creating = false;
    }
  }

  function openSearch(): void {
    searchOpen = true;
    setTimeout(() => searching?.focus(), 20);
  }

  // ⌘K / Ctrl+K opens chat search, like the mock's hint.
  function onKey(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openSearch();
    }
  }

  const visible = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return q === "" ? app.chats : app.chats.filter((c) => c.title.toLowerCase().includes(q));
  });

  /** Mock-style relative stamp: "now", "2m", "18m", "5h", "3d", weekday. */
  function rel(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const mins = Math.round((Date.now() - d.getTime()) / 60_000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    const h = Math.round(mins / 60);
    if (h < 24) return `${h}h`;
    const days = Math.round(h / 24);
    if (days < 7) return `${days}d`;
    return d.toLocaleDateString([], { weekday: "short" });
  }
</script>

<svelte:window onkeydown={onKey} />

<aside class="side">
  <div class="brand">
    <svg class="mark" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path d="M12 2.6 13.7 10.3 21.4 12 13.7 13.7 12 21.4 10.3 13.7 2.6 12 10.3 10.3Z" fill="var(--accent)" />
    </svg>
    <span class="name">Foundry</span>
    <div class="grow"></div>
    <span class="conn" title={`connection: ${app.conn}`} aria-label="connection">
      <span class="dot {app.conn}"></span>
    </span>
  </div>

  <nav class="nav">
    <button class="navrow" onclick={newChat} disabled={creating}>
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none" />
      </svg>
      <span>New chat</span>
      <div class="grow"></div>
      <kbd>⌘K</kbd>
    </button>

    <button class="navrow" class:lit={searchOpen} onclick={openSearch}>
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <circle cx="7" cy="7" r="4.3" stroke="currentColor" stroke-width="1.4" fill="none" />
        <path d="M10.4 10.4 13.5 13.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
      <span>Search</span>
      <div class="grow"></div>
    </button>

    {#if searchOpen}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="searchbox"
        placeholder="Filter chats…"
        bind:this={searching}
        bind:value={query}
        autofocus
        onkeydown={(e) => {
          if (e.key === "Escape") {
            query = "";
            searchOpen = false;
          }
        }}
      />
    {/if}
  </nav>

  <div class="scroll">
    <p class="seclabel">Recent</p>
    {#each visible as chat (chat.id)}
      <button class="row" class:active={chat.id === app.activeChatId} onclick={() => void selectChat(chat.id)}>
        <span class="t">{chat.title}</span>
        <span class="r">{rel(chat.updatedAt)}</span>
      </button>
    {:else}
      <p class="muted empty">{query === "" ? "No chats yet — start one above." : "No matches."}</p>
    {/each}
  </div>

  <div class="userfoot">
    <span class="avatar local" aria-hidden="true">A</span>
    <div class="who">
      <div class="n">local session</div>
      <div class="s">foundry · self-hosted</div>
    </div>
    <div class="grow"></div>
    <button class="icon-btn" title="Settings" aria-label="Settings" onclick={() => setView(app.view === "settings" ? "chat" : "settings")}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <g stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round">
          <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
          <circle cx="10.5" cy="4.5" r="1.9" fill="var(--bg-raised)" />
          <circle cx="5" cy="8" r="1.9" fill="var(--bg-raised)" />
          <circle cx="8.5" cy="11.5" r="1.9" fill="var(--bg-raised)" />
        </g>
      </svg>
    </button>
    <button class="icon-btn" title="Sign out" aria-label="Sign out" onclick={logout}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <g stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path d="M7 2.5H4.2A1.2 1.2 0 0 0 3 3.7v8.6a1.2 1.2 0 0 0 1.2 1.2H7" />
          <path d="M9.5 5.5 12 8l-2.5 2.5" />
          <path d="M12 8H6.5" />
        </g>
      </svg>
    </button>
  </div>
</aside>

<style>
  .side {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-side);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 16px 10px;
  }

  .name {
    font-weight: 700;
    font-size: 14.5px;
    letter-spacing: 0.01em;
  }

  .grow {
    flex: 1;
  }

  .conn {
    display: inline-flex;
  }

  nav .navrow {
    display: flex;
    align-items: center;
    gap: 9px;
    width: calc(100% - 12px);
    margin: 1px 6px;
    padding: 6px 8px;
    background: transparent;
    border: none;
    border-radius: 8px;
    color: var(--fg);
    font-size: 13.5px;
  }

  nav .navrow:hover {
    background: var(--bg-overlay);
  }

  nav .navrow.lit,
  nav .navrow svg {
    color: var(--fg-dim);
  }

  nav .navrow.lit {
    color: var(--accent);
  }

  nav .navrow:hover svg {
    color: var(--fg);
  }

  .searchbox {
    margin: 2px 6px 4px;
    padding: 5px 10px;
    font-size: 13px;
    border-radius: 8px;
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 6px;
  }

  .seclabel {
    margin: 8px 10px 6px;
    font-size: 11px;
    font-weight: 600;
    color: var(--fg-faint);
    letter-spacing: 0.05em;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 8px;
    padding: 6px 10px;
    color: var(--fg);
  }

  .row:hover {
    background: var(--bg-overlay);
  }

  .row.active {
    background: var(--bg-overlay);
  }

  .row .t {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 13.5px;
  }

  .row .r {
    font-size: 11px;
    color: var(--fg-faint);
    flex: none;
  }

  .empty {
    font-size: 12.5px;
    margin: 10px;
  }

  .userfoot {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px 12px;
    border-top: 1px solid var(--border-soft);
  }

  .avatar {
    width: 30px;
    height: 30px;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 700;
    font-size: 13px;
  }

  .who {
    min-width: 0;
  }

  .who .n {
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
  }

  .who .s {
    font-size: 11px;
    color: var(--fg-faint);
    white-space: nowrap;
  }
</style>