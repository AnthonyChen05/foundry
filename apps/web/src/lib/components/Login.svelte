<script lang="ts">
  import { app, loginWithPassword } from "$lib/foundry.svelte";

  let username = $state("admin");
  let password = $state("");
  let busy = $state(false);

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (busy || username.trim().length === 0 || password.length === 0) return;
    busy = true;
    try {
      await loginWithPassword(username, password);
    } finally {
      busy = false;
    }
  }
</script>

<div class="gate-page">
  <form class="card" onsubmit={submit}>
    <span class="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="26" height="26">
        <path d="M12 2.6 13.7 10.3 21.4 12 13.7 13.7 12 21.4 10.3 13.7 2.6 12 10.3 10.3Z" fill="currentColor" />
      </svg>
    </span>
    <h1>Foundry</h1>
    <p class="muted">Self-hosted LLM backend. Sign in with your username and password to start a session (lasts 30 days).</p>
    <input
      type="text"
      placeholder="username"
      autocomplete="username"
      spellcheck="false"
      bind:value={username}
      disabled={busy}
    />
    <input
      type="password"
      placeholder="password"
      autocomplete="current-password"
      bind:value={password}
      disabled={busy}
    />
    {#if app.connError !== ""}
      <p class="error-text">{app.connError}</p>
    {/if}
    <button class="primary" type="submit" disabled={busy || username.trim().length === 0 || password.length === 0}>
      {busy ? "Signing in…" : "Sign in"}
    </button>
  </form>
</div>

<style>
  .gate-page {
    height: 100vh;
    height: 100dvh;
    display: grid;
    place-items: center;
    padding: 16px;
  }

  .card {
    width: min(400px, 92vw);
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 30px 30px 26px;
    background: var(--bg);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-lg);
  }

  .mark {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--accent-soft);
    color: var(--accent);
  }

  .card h1 {
    margin: 4px 0 0;
    font-size: 20px;
    letter-spacing: 0.01em;
  }

  .card p {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
  }

  .card button[type="submit"] {
    margin-top: 6px;
    padding: 9px 14px;
    font-size: 14px;
  }
</style>