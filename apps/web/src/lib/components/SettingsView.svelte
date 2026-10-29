<script lang="ts">
  import { untrack } from "svelte";
  import { rest } from "$lib/foundry.svelte";
  import type { McpServerConfig } from "@foundry/sdk-ts";

  type Tab = "providers" | "models" | "keys" | "account" | "schedules" | "hooks" | "mcp" | "system";
  const TABS: { id: Tab; label: string }[] = [
    { id: "providers", label: "Providers" },
    { id: "models", label: "Models" },
    { id: "keys", label: "API keys" },
    { id: "account", label: "Account" },
    { id: "schedules", label: "Schedules" },
    { id: "hooks", label: "Webhooks" },
    { id: "mcp", label: "MCP" },
    { id: "system", label: "System" },
  ];

  let tab = $state<Tab>("providers");
  let note = $state("");
  let busy = $state(false);

  function error(err: unknown): void {
    note = err instanceof Error ? err.message : String(err);
  }

  type Section = Tab;
  /** Server reads for the visible section — no busy gate, no note stomping.
   *  "account" has nothing to fetch (falls out of the switch). */
  async function fetchInto(section: Section): Promise<void> {
    switch (section) {
      case "account":
        return;
      case "providers":
        providers = (await rest().adminListProviders()).providers;
        break;
      case "models": {
        const [p, cat] = await Promise.all([rest().adminListProfiles(), rest().models()]);
        profiles = p.profiles;
        // The wrap targets = the RAW catalog (profiles excluded).
        catModels = cat.data.filter((m) => !m.id.startsWith("mp_")).map((m) => ({ id: m.id, name: m.name, avatar: m.avatar }));
        break;
      }
      case "keys":
        keys = (await rest().adminListKeys()).keys;
        break;
      case "schedules":
        schedules = (await rest().adminListSchedules()).schedules;
        break;
      case "hooks":
        hooks = (await rest().adminListHooks()).hooks;
        break;
      case "mcp":
        mcp = (await rest().adminGetMcpServers()).status;
        break;
      case "system": {
        const [audit, backupList] = await Promise.all([rest().adminListAudit(auditLimit), rest().adminListBackups()]);
        auditRows = audit.events;
        backups = backupList.backups;
        break;
      }
    }
  }

  /** A mutating op under the busy gate; `refresh` is its post-save read. */
  function run(action: (refresh: () => Promise<void>) => Promise<void>): void {
    void (async () => {
      busy = true;
      note = "";
      try {
        await action(() => fetchInto(tab));
      } catch (err) {
        note = err instanceof Error ? err.message : String(err);
      } finally {
        busy = false;
      }
    })();
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
    void fetchInto("providers").catch(error);
  }

  function saveProvider(): void {
    void run(async (refresh) => {
      // Model ids one per line. Empty = pull them from the provider's
      // OpenAI-compatible /models endpoint (Ollama/LM Studio/vLLM/…).
      const models = pModels
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((id) => ({ id }));
      const res = await rest().adminUpsertProvider({
        kind: pKind,
        baseUrl: pBase,
        ...(pKey.trim().length > 0 ? { apiKey: pKey.trim() } : {}),
        ...(models.length > 0 ? { models } : {}),
      });
      pKey = "";
      if (res.pullError !== undefined) {
        error(new Error(`saved ${res.id}, but model auto-pull failed: ${res.pullError} — enter models manually`));
      }
      await refresh();
    });
  }

  function delProvider(id: string): void {
    void run(async (refresh) => {
      await rest().adminDeleteProvider(id);
      await refresh();
    });
  }

  // -- model profiles (personality pages; select like any model) -------------

  interface ModelRow {
    id: string;
    name: string;
    avatar?: string;
  }

  interface ProfileRow {
    id: string;
    userId: string;
    baseModelId: string;
    name: string;
    avatar?: string | null;
    systemPrompt?: string | null;
    params?: Record<string, unknown> | null;
    enabled: boolean;
    createdAt: number;
  }

  let profiles = $state<ProfileRow[]>([]);
  let catModels = $state<ModelRow[]>([]);

  let editingId = $state(""); // "" = create
  let eName = $state("");
  let eAvatar = $state("");
  let eBase = $state("");
  let eSystem = $state("");
  let eTemp = $state("");
  let eTopP = $state("");
  let eMaxTokens = $state("");
  let ePresence = $state("");
  let eFrequency = $state("");
  let eSeed = $state("");
  let eStop = $state(""); // stop sequences — one per line

  function numParam(s: string): number | undefined {
    const t = s.trim();
    if (t.length === 0) return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }

  const paramText = (v: unknown): string => (typeof v === "number" ? String(v) : "");

  function editProfile(p?: ProfileRow): void {
    editingId = p?.id ?? "";
    eName = p?.name ?? "";
    eAvatar = p?.avatar ?? "";
    eBase = p?.baseModelId ?? "";
    eSystem = p?.systemPrompt ?? "";
    const params = p?.params ?? undefined;
    eTemp = paramText(params?.["temperature"]);
    eTopP = paramText(params?.["top_p"]);
    eMaxTokens = paramText(params?.["max_tokens"]);
    ePresence = paramText(params?.["presence_penalty"]);
    eFrequency = paramText(params?.["frequency_penalty"]);
    eSeed = paramText(params?.["seed"]);
    const stop = params?.["stop"];
    eStop = Array.isArray(stop) ? stop.filter((s) => typeof s === "string").join("\n") : typeof stop === "string" ? stop : "";
  }

  function saveProfile(): void {
    void run(async (refresh) => {
      if (eBase === "") throw new Error("pick a base model");
      if (eName.trim().length === 0) throw new Error("name required");
      const params: Record<string, unknown> = {};
      if (eTemp.trim() !== "") params["temperature"] = numParam(eTemp);
      if (eTopP.trim() !== "") params["top_p"] = numParam(eTopP);
      if (eMaxTokens.trim() !== "") params["max_tokens"] = numParam(eMaxTokens);
      if (ePresence.trim() !== "") params["presence_penalty"] = numParam(ePresence);
      if (eFrequency.trim() !== "") params["frequency_penalty"] = numParam(eFrequency);
      if (eSeed.trim() !== "") params["seed"] = numParam(eSeed);
      if (eStop.trim() !== "") {
        const stops = eStop.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
        params["stop"] = stops.length === 1 ? stops[0] : stops;
      }
      await rest().adminUpsertProfile({
        ...(editingId !== "" ? { id: editingId } : {}),
        baseModelId: eBase,
        name: eName.trim(),
        ...(eAvatar.trim() !== "" ? { avatar: eAvatar.trim() } : {}),
        ...(eSystem.trim() !== "" ? { systemPrompt: eSystem } : {}),
        params: Object.keys(params).length > 0 ? params : null,
      });
      editProfile(undefined);
      await refresh();
    });
  }

  function delProfile(id: string): void {
    void run(async (refresh) => {
      await rest().adminDeleteProfile(id);
      if (editingId === id) editProfile(undefined);
      await refresh();
    });
  }

  // -- keys ----------------------------------------------------------------

  let keys = $state<{ id: string; name: string }[]>([]);
  let keyName = $state("");
  let freshKey = $state("");

  function refreshKeys(): void {
    void fetchInto("keys").catch(error);
  }

  function createKey(): void {
    void run(async (refresh) => {
      const res = await rest().adminCreateKey(keyName.trim().length > 0 ? keyName.trim() : undefined);
      freshKey = res.key;
      keyName = "";
      await refresh();
    });
  }

  function revokeKey(id: string): void {
    void run(async (refresh) => {
      await rest().adminRevokeKey(id);
      await refresh();
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
    void fetchInto("schedules").catch(error);
  }

  function createSchedule(): void {
    void run(async (refresh) => {
      await rest().adminCreateSchedule({
        name: sName.trim(),
        kind: sKind,
        spec: sSpec.trim(),
        prompt: sPrompt.trim(),
      });
      sName = "";
      sPrompt = "";
      await refresh();
    });
  }

  function toggleSchedule(id: string, enabled: boolean, reschedule: boolean): void {
    void run(async (refresh) => {
      await rest().adminPatchSchedule(id, { enabled, ...(reschedule ? { reschedule: true } : {}) });
      await refresh();
    });
  }

  function delSchedule(id: string): void {
    void run(async (refresh) => {
      await rest().adminDeleteSchedule(id);
      await refresh();
    });
  }

  // -- hooks ---------------------------------------------------------------

  let hooks = $state<{ id: string; name: string; target: string; createdAt: string }[]>([]);
  let hName = $state("");
  let freshHook = $state<{ url: string; secret: string } | undefined>(undefined);

  function refreshHooks(): void {
    void fetchInto("hooks").catch(error);
  }

  function createHook(): void {
    void run(async (refresh) => {
      const res = await rest().adminCreateHook(hName.trim());
      freshHook = { url: res.url, secret: res.secret };
      hName = "";
      await refresh();
    });
  }

  function delHook(id: string): void {
    void run(async (refresh) => {
      await rest().adminDeleteHook(id);
      await refresh();
    });
  }

  // -- mcp -----------------------------------------------------------------

  let mcp = $state<{ name: string; connected: boolean; tools: number; error?: string }[]>([]);
  let mcpJson = $state("[]");

  function refreshMcp(): void {
    void fetchInto("mcp").catch(error);
  }

  function saveMcp(): void {
    void run(async (refresh) => {
      const servers = JSON.parse(mcpJson) as McpServerConfig[];
      await rest().adminPutMcpServers(servers);
      await refresh();
    });
  }

  // -- account (ADR-006: password change) ----------------------------------

  let curPw = $state("");
  let newPw = $state("");
  let newPw2 = $state("");
  let pwSaved = $state(false);

  function savePassword(): void {
    void run(async (_refresh) => {
      pwSaved = false;
      if (newPw.length < 8) throw new Error("New password must be at least 8 characters.");
      if (newPw !== newPw2) throw new Error("New passwords do not match.");
      await rest().changePassword(curPw, newPw);
      curPw = newPw = newPw2 = "";
      pwSaved = true;
    });
  }

  // -- system (P5): audit log + backups ------------------------------------

  interface AuditRow {
    id: number;
    at: number;
    userId: string | null;
    action: string;
    target: string | null;
    outcome: string;
    meta?: Record<string, unknown> | null;
  }

  let auditRows = $state<AuditRow[]>([]);
  let auditLimit = $state(200);
  let backups = $state<{ dir: string; bytes: number }[]>([]);

  function refreshSystem(): void {
    void fetchInto("system").catch(error);
  }

  function runBackup(): void {
    void run(async () => {
      await rest().adminRunBackup();
      backups = (await rest().adminListBackups()).backups;
    });
  }

  function fmtBytes(n: number): string {
    return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(1)} MiB`;
  }

  function fmtAt(at: number): string {
    return new Date(at).toLocaleString();
  }

  // Tab switch → load that section. untrack: the read path's own writes
  // (providers/keys/…/busy) must not re-trigger this effect (without it the
  // fetch's busy flips made the effect fire itself forever).
  $effect(() => {
    const t = tab;
    untrack(() => {
      void fetchInto(t).catch(error);
    });
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
          <label for="p-models">models — one id per line (empty = pull from the provider's /models)</label>
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
    {:else if tab === "models"}
      <!-- The personality editor: a profile wraps a base model with a
           persona + default advanced params, selectable everywhere. -->
      <div class="form formcard">
        <div class="edhead">
          <strong>{editingId === "" ? "New model page" : `Model page${eAvatar !== "" ? ` ${eAvatar}` : ""} ${eName}`}</strong>
          <button class="ghost" onclick={() => editProfile(undefined)} type="button">new page</button>
        </div>
        <div class="field">
          <label for="mp-name">name</label>
          <input id="mp-name" bind:value={eName} />
        </div>
        <div class="field">
          <label for="mp-avatar">avatar (emoji)</label>
          <input id="mp-avatar" bind:value={eAvatar} maxlength="4" />
        </div>
        <div class="field">
          <label for="mp-base">base model</label>
          <select id="mp-base" bind:value={eBase}>
            <option value="">— pick a base —</option>
            {#each catModels as m (m.id)}
              <option value={m.id}>{m.avatar ?? ""} {m.name} ({m.id})</option>
            {/each}
          </select>
        </div>
        <div class="field">
          <label for="mp-sys">system prompt — the personality it answers as</label>
          <textarea id="mp-sys" rows="6" bind:value={eSystem}></textarea>
        </div>
        <div class="field">
          <!-- @svelte-ignore a11y_label_has_associated_control: a heading-style label over a param GRID -->
          <label>advanced params (defaults — a request's explicit values win)</label>
          <div class="pgrid">
            <input placeholder="temperature" bind:value={eTemp} />
            <input placeholder="top_p" bind:value={eTopP} />
            <input placeholder="max_tokens" bind:value={eMaxTokens} />
            <input placeholder="presence_penalty" bind:value={ePresence} />
            <input placeholder="frequency_penalty" bind:value={eFrequency} />
            <input placeholder="seed" bind:value={eSeed} />
            <textarea placeholder="stop — one per line" rows="2" bind:value={eStop}></textarea>
          </div>
        </div>
        <div class="inline">
          <button class="primary" onclick={saveProfile} disabled={busy || eName.trim() === "" || eBase === ""}>
            {editingId === "" ? "Create" : "Save"}
          </button>
        </div>
      </div>
      <table>
        <thead><tr><th>page</th><th>name</th><th>base</th><th>id</th><th></th></tr></thead>
        <tbody>
          {#each profiles as p (p.id)}
            <tr>
              <td>{p.avatar ?? ""}</td>
              <td>{p.name}{p.enabled ? "" : " (off)"}</td>
              <td class="mono">{p.baseModelId}</td>
              <td class="mono">{p.id}</td>
              <td>
                <button class="ghost" onclick={() => editProfile(p)}>edit</button>
                <button class="ghost" onclick={() => delProfile(p.id)}>delete</button>
              </td>
            </tr>
          {:else}
            <tr><td colspan="5" class="muted">No model pages yet — the chat picker lists raw provider models.</td></tr>
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
    {:else if tab === "system"}
      <div class="form">
        <div class="inline">
          <input type="number" min="1" max="1000" bind:value={auditLimit} />
          <button class="ghost" onclick={refreshSystem} disabled={busy}>Refresh log</button>
          <button class="primary" onclick={runBackup} disabled={busy}>Run backup now</button>
          <button class="ghost" onclick={refreshSystem} disabled={busy}>Refresh backups</button>
        </div>
      </div>
      <h3>Backups</h3>
      <table>
        <thead><tr><th>dir</th><th>size</th></tr></thead>
        <tbody>
          {#each backups as b (b.dir)}
            <tr>
              <td>{b.dir}</td>
              <td>{fmtBytes(b.bytes)}</td>
            </tr>
          {:else}
            <tr><td colspan="2" class="muted">No backups yet.</td></tr>
          {/each}
        </tbody>
      </table>
      <h3>Audit log</h3>
      <table>
        <thead><tr><th>when</th><th>user</th><th>action</th><th>target</th><th>outcome</th></tr></thead>
        <tbody>
          {#each auditRows as e (e.id)}
            <tr>
              <td>{fmtAt(e.at)}</td>
              <td class="muted">{e.userId === null ? "—" : e.userId}</td>
              <td>{e.action}</td>
              <td class="muted">{e.target ?? ""}</td>
              <td class={e.outcome !== "ok" ? "error-text" : undefined}>{e.outcome}</td>
            </tr>
          {:else}
            <tr><td colspan="5" class="muted">Nothing audited yet.</td></tr>
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