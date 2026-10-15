<script lang="ts">
  import { rest } from "$lib/foundry.svelte";
  import type { McpServerConfig } from "@foundry/sdk-ts";

  type Tab = "providers" | "keys" | "account" | "schedules" | "hooks" | "mcp";
  const TABS: { id: Tab; label: string }[] = [
    { id: "providers", label: "Providers" },
    { id: "keys", label: "API keys" },
    { id: "account", label: "Account" },
    { id: "schedules", label: "Schedules" },
    { id: "hooks", label: "Webhooks" },
    { id: "mcp", label: "MCP" },
  ];

  let tab = $state<Tab>("providers");
  let note = $state("");
  let busy = $state(false);

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    note = "";
    try {
      await action();
    } catch (err) {
      note = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  // -- providers -----------------------------------------------------------

  interface ProviderRow {
    id: string;
    kind: string;
    baseUrl: string | null;
    enabled: boolean;
    hasKey: boolean;
  }

  let providers = $state<ProviderRow[]>([]);
  let pKind = $state("openai_compat");
  let pBase = $state("https://api.openai.com/v1");
  let pKey = $state("");
  let pModels = $state("");

  function refreshProviders(): void {
    void run(async () => {
      providers = (await rest().adminListProviders()).providers;
    });
  }

  function saveProvider(): void {
    void run(async () => {
      // Model ids one per line; empty for providers known by their base URL.
      const models = pModels
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((id) => ({ id }));
      await rest().adminUpsertProvider({
        kind: pKind,
        baseUrl: pBase,
        ...(pKey.trim().length > 0 ? { apiKey: pKey.trim() } : {}),
        ...(models.length > 0 ? { models } : {}),
      });
      pKey = "";
      refreshProviders();
    });
  }

  function delProvider(id: string): void {
    void run(async () => {
      await rest().adminDeleteProvider(id);
      refreshProviders();
    });
  }

  // -- keys ----------------------------------------------------------------

  let keys = $state<{ id: string; name: string }[]>([]);
  let keyName = $state("");
  let freshKey = $state("");

  function refreshKeys(): void {
    void run(async () => {
      keys = (await rest().adminListKeys()).keys;
    });
  }

  function createKey(): void {
    void run(async () => {
      const res = await rest().adminCreateKey(keyName.trim().length > 0 ? keyName.trim() : undefined);
      freshKey = res.key;
      keyName = "";
      refreshKeys();
    });
  }

  function revokeKey(id: string): void {
    void run(async () => {
      await rest().adminRevokeKey(id);
      refreshKeys();
    });
  }

  // -- schedules -----------------------------------------------------------

  let schedules = $state<
    {
      id: string;
      name: string;
      kind: string;
      spec: string;
      prompt: string;
      model?: string | null;
      enabled: boolean;
      nextRunAt: string;
      lastRunId?: string | null;
    }[]
  >([]);
  let sName = $state("");
  let sKind = $state<"cron" | "every">("cron");
  let sSpec = $state("*/15 * * * *");
  let sPrompt = $state("");

  function refreshSchedules(): void {
    void run(async () => {
      schedules = (await rest().adminListSchedules()).schedules;
    });
  }

  function createSchedule(): void {
    void run(async () => {
      await rest().adminCreateSchedule({
        name: sName.trim(),
        kind: sKind,
        spec: sSpec.trim(),
        prompt: sPrompt.trim(),
      });
      sName = "";
      sPrompt = "";
      refreshSchedules();
    });
  }

  function toggleSchedule(id: string, enabled: boolean, reschedule: boolean): void {
    void run(async () => {
      await rest().adminPatchSchedule(id, { enabled, ...(reschedule ? { reschedule: true } : {}) });
      refreshSchedules();
    });
  }

  function delSchedule(id: string): void {
    void run(async () => {
      await rest().adminDeleteSchedule(id);
      refreshSchedules();
    });
  }

  // -- hooks ---------------------------------------------------------------

  let hooks = $state<{ id: string; name: string; target: string; createdAt: string }[]>([]);
  let hName = $state("");
  let freshHook = $state<{ url: string; secret: string } | undefined>(undefined);

  function refreshHooks(): void {
    void run(async () => {
      hooks = (await rest().adminListHooks()).hooks;
    });
  }

  function createHook(): void {
    void run(async () => {
      const res = await rest().adminCreateHook(hName.trim());
      freshHook = { url: res.url, secret: res.secret };
      hName = "";
      refreshHooks();
    });
  }

  function delHook(id: string): void {
    void run(async () => {
      await rest().adminDeleteHook(id);
      refreshHooks();
    });
  }

  // -- mcp -----------------------------------------------------------------

  let mcp = $state<{ name: string; connected: boolean; tools: number; error?: string }[]>([]);
  let mcpJson = $state("[]");

  function refreshMcp(): void {
    void run(async () => {
      mcp = (await rest().adminGetMcpServers()).status;
    });
  }

  function saveMcp(): void {
    void run(async () => {
      const servers = JSON.parse(mcpJson) as McpServerConfig[];
      await rest().adminPutMcpServers(servers);
      refreshMcp();
    });
  }

  // -- account (ADR-006: password change) ----------------------------------

  let curPw = $state("");
  let newPw = $state("");
  let newPw2 = $state("");
  let pwSaved = $state(false);

  function savePassword(): void {
    void run(async () => {
      pwSaved = false;
      if (newPw.length < 8) throw new Error("New password must be at least 8 characters.");
      if (newPw !== newPw2) throw new Error("New passwords do not match.");
      await rest().changePassword(curPw, newPw);
      curPw = newPw = newPw2 = "";
      pwSaved = true;
    });
  }

  // tab switching refreshes the visible section
  $effect(() => {
    switch (tab) {
      case "providers":
        refreshProviders();
        break;
      case "keys":
        refreshKeys();
        break;
      case "schedules":
        refreshSchedules();
        break;
      case "hooks":
        refreshHooks();
        break;
      case "mcp":
        refreshMcp();
        break;
    }
  });
</script>

<div class="pane">
  <div class="pane-head">
    <h2>Settings</h2>
    <div class="tabs">
      {#each TABS as t}
        <button class:on={tab === t.id} onclick={() => (tab = t.id)}>{t.label}</button>
      {/each}
    </div>
  </div>

  <div class="pane-body">
    {#if note !== ""}
      <p class="error-text">{note}</p>
    {/if}

    {#if tab === "providers"}
      <form class="form" onsubmit={(e) => e.preventDefault()}>
        <div class="field">
          <label for="p-kind">type</label>
          <select id="p-kind" bind:value={pKind}>
            <option value="openai_compat">openai_compat</option>
            <option value="anthropic">anthropic (translate shim)</option>
          </select>
        </div>
        <div class="field">
          <label for="p-base">base URL</label>
          <input id="p-base" bind:value={pBase} />
        </div>
        <div class="field">
          <label for="p-key">API key (stored in the vault; sent to nothing else)</label>
          <input id="p-key" type="password" bind:value={pKey} placeholder="sk-…" autocomplete="off" />
        </div>
        <div class="field">
          <label for="p-models">models — one id per line (optional)</label>
          <textarea id="p-models" rows="3" bind:value={pModels} placeholder="gpt-4o&#10;gpt-4o-mini"></textarea>
        </div>
        <button class="primary" onclick={saveProvider} disabled={busy}>Save provider</button>
      </form>
      <table>
        <thead><tr><th>id</th><th>kind</th><th>base url</th><th>key</th><th></th></tr></thead>
        <tbody>
          {#each providers as pr (pr.id)}
            <tr>
              <td class="mono">{pr.id}</td>
              <td>{pr.kind}</td>
              <td class="mono">{pr.baseUrl ?? ""}</td>
              <td>{pr.hasKey ? "✓" : "—"}</td>
              <td><button class="ghost" onclick={() => delProvider(pr.id)}>delete</button></td>
            </tr>
          {:else}
            <tr><td colspan="5" class="muted">No providers yet.</td></tr>
          {/each}
        </tbody>
      </table>
    {:else if tab === "keys"}
      <div class="form">
        <div class="inline">
          <input placeholder="key name (optional)" bind:value={keyName} />
          <button class="primary" onclick={createKey} disabled={busy}>Create</button>
        </div>
        {#if freshKey !== ""}
          <div>
            <p class="muted">Copy this now — it is not shown again:</p>
            <p class="secret">{freshKey}</p>
          </div>
        {/if}
      </div>
      <table>
        <thead><tr><th>id</th><th>name</th><th></th></tr></thead>
        <tbody>
          {#each keys as k (k.id)}
            <tr>
              <td class="mono">{k.id}</td>
              <td>{k.name}</td>
              <td><button class="ghost" onclick={() => revokeKey(k.id)}>revoke</button></td>
            </tr>
          {:else}
            <tr><td colspan="3" class="muted">No keys.</td></tr>
          {/each}
        </tbody>
      </table>
    {:else if tab === "account"}
      <form class="form" onsubmit={(e) => { e.preventDefault(); savePassword(); }}>
        <p class="muted">
          You sign in with your username and this password (sessions last 30 days).
          API keys are a separate credential for programmatic OpenAI-compatible
          clients and are unaffected.
        </p>
        <div class="field">
          <label for="a-cur">current password</label>
          <input id="a-cur" type="password" bind:value={curPw} autocomplete="current-password" />
        </div>
        <div class="field">
          <label for="a-new">new password (min 8 characters)</label>
          <input id="a-new" type="password" bind:value={newPw} autocomplete="new-password" />
        </div>
        <div class="field">
          <label for="a-new2">repeat new password</label>
          <input id="a-new2" type="password" bind:value={newPw2} autocomplete="new-password" />
        </div>
        <button class="primary" type="submit" disabled={busy}>Change password</button>
        {#if pwSaved}<p class="muted">Password changed.</p>{/if}
      </form>
    {:else if tab === "schedules"}
      <div class="form">
        <div class="inline">
          <input placeholder="name" bind:value={sName} />
          <select bind:value={sKind} style="width:auto">
            <option value="cron">cron</option>
            <option value="every">every</option>
          </select>
          <input placeholder={sKind === "cron" ? "*/15 * * * *" : "900"} bind:value={sSpec} />
        </div>
        <textarea rows="2" placeholder="prompt sent to the agent on each fire" bind:value={sPrompt}></textarea>
        <button class="primary" onclick={createSchedule} disabled={busy || sName.trim() === "" || sPrompt.trim() === ""}>
          Create schedule
        </button>
      </div>
      <table>
        <thead><tr><th>name</th><th>spec</th><th>next</th><th>on</th><th></th></tr></thead>
        <tbody>
          {#each schedules as s (s.id)}
            <tr>
              <td>{s.name}</td>
              <td class="mono">{s.kind} · {s.spec}</td>
              <td>{s.nextRunAt}</td>
              <td>{s.enabled ? "✓" : "—"}</td>
              <td>
                <button class="ghost" onclick={() => toggleSchedule(s.id, !s.enabled, !s.enabled)}>
                  {s.enabled ? "pause" : "resume"}
                </button>
                <button class="ghost" onclick={() => delSchedule(s.id)}>delete</button>
              </td>
            </tr>
          {:else}
            <tr><td colspan="5" class="muted">No schedules.</td></tr>
          {/each}
        </tbody>
      </table>
    {:else if tab === "hooks"}
      <div class="form">
        <div class="inline">
          <input placeholder="hook name" bind:value={hName} />
          <button class="primary" onclick={createHook} disabled={busy || hName.trim() === ""}>Create</button>
        </div>
        {#if freshHook !== undefined}
          <div>
            <p class="muted">POST JSON <code>{"{ content }"}</code> to this URL with header
              <code>x-foundry-signature</code>:</p>
            <pre>{freshHook.url}</pre>
            <p class="secret">{freshHook.secret}</p>
          </div>
        {/if}
      </div>
      <table>
        <thead><tr><th>name</th><th>target</th><th></th></tr></thead>
        <tbody>
          {#each hooks as h (h.id)}
            <tr>
              <td>{h.name}</td>
              <td>{h.target}</td>
              <td><button class="ghost" onclick={() => delHook(h.id)}>delete</button></td>
            </tr>
          {:else}
            <tr><td colspan="3" class="muted">No webhooks.</td></tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <p class="muted">MCP servers are configured as one JSON document (PUT replaces all):</p>
      <textarea rows="6" bind:value={mcpJson}></textarea>
      <button class="primary" onclick={saveMcp} disabled={busy}>Apply servers</button>
      <table>
        <thead><tr><th>name</th><th>connected</th><th>tools</th><th>error</th></tr></thead>
        <tbody>
          {#each mcp as s (s.name)}
            <tr>
              <td>{s.name}</td>
              <td>{s.connected ? "✓" : "—"}</td>
              <td>{String(s.tools)}</td>
              <td class="error-text">{s.error ?? ""}</td>
            </tr>
          {:else}
            <tr><td colspan="4" class="muted">No MCP servers configured.</td></tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>

<style>
  .pane-body > :is(form, textarea, button, table, p) {
    margin-bottom: 14px;
  }

  textarea {
    max-width: 640px;
  }
</style>