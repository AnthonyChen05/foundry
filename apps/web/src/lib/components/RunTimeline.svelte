<script lang="ts">
  import {
    app,
    cancelRun,
    chatById,
    gatesFor,
    pushChatToCloud,
    resolveGate,
    runsOfChat,
    timelineFor,
    type GateScope,
  } from "$lib/foundry.svelte";

  let scopes = $state<Record<string, GateScope>>({});

  async function onPush(chatId: string): Promise<void> {
    await pushChatToCloud(chatId);
  }

  /** Runs of the active chat, plus orphan runs (schedules/webhooks). */
  const runs = $derived([
    ...runsOfChat(app.activeChatId),
    ...app.runOrder
      .map((id) => app.runs[id])
      .filter((r): r is NonNullable<typeof r> => r !== undefined && r.conversationId === undefined)
      .reverse(),
  ]);

  const run = $derived(app.selectedRunId === "" ? undefined : app.runs[app.selectedRunId]);
  const gates = $derived(run === undefined ? [] : gatesFor(run.id));
  const events = $derived(run === undefined ? [] : timelineFor(run.id));

  function isActive(r: { status: string }): boolean {
    return r.status === "queued" || r.status === "running" || r.status === "waiting_approval";
  }

  async function onCancel(id: string): Promise<void> {
    try {
      await cancelRun(id);
    } catch (err) {
      app.connError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onApprove(gateId: string, approve: boolean): Promise<void> {
    if (run === undefined) return;
    const scope: GateScope = scopes[gateId] ?? "once";
    try {
      await resolveGate(run.id, gateId, approve, scope);
    } catch (err) {
      app.connError = err instanceof Error ? err.message : String(err);
    }
  }

  function jsonOf(payload: unknown): string {
    let s: string;
    try {
      s = JSON.stringify(payload, null, 1) ?? "undefined";
    } catch {
      s = String(payload);
    }
    return s.length > 1600 ? s.slice(0, 1600) + " …" : s;
  }

  function short(id: string): string {
    return id.length > 14 ? id.slice(0, 14) + "…" : id;
  }
</script>

<div class="pane runpane">
  <div class="body">
    {#if runs.length === 0}
      <p class="muted hint">No runs yet — send a message and live runs appear here, events streaming as they happen.</p>
    {:else}
      {#if run === undefined || !runs.some((r) => r.id === run.id)}
        <p class="muted hint">No run selected — pick one or start a send.</p>
      {/if}
      <select class="runselp" aria-label="Select run" bind:value={app.selectedRunId}>
        {#each runs as r (r.id)}
          <option value={r.id}>{r.status} · {short(r.id)} · {r.model || r.trigger}</option>
        {/each}
      </select>
      {#if run !== undefined}
        <div class="head">
          <span class="badge {run.status}">{run.status}</span>
          <span class="crumb muted">{run.model || run.trigger}</span>
          <div class="spacer"></div>
          {#if chatById(run.conversationId ?? "")?.location === "local"}
            <button class="pushbtn" onclick={() => void onPush(run.conversationId ?? "")} title="Move this chat's workspace + dependencies to the backend sandbox (ADR-015)">
              Push to cloud
            </button>
          {/if}
          {#if isActive(run)}
            <button class="icon-btn" title="Cancel run" aria-label="Cancel run" onclick={() => void onCancel(run.id)}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
              </svg>
            </button>
          {/if}
        </div>
        {#if run.error !== undefined}
          <p class="error-text">{run.error}</p>
        {/if}

        {#if gates.length > 0}
          <p class="seclabel">Awaiting approval</p>
          <div class="gates">
            {#each gates as g (g.gateId)}
              <div class="gate">
                <span class="tool">⚠ {g.tool}</span>
                <pre>{jsonOf(g.args)}</pre>
                <div class="grow">
                  <label class="scope" title="If approved: this call, this session, or forever.">
                    scope
                    <select bind:value={scopes[g.gateId]}>
                      <option value="once">once</option>
                      <option value="session">session</option>
                      <option value="always">always</option>
                    </select>
                  </label>
                  <button class="approve" onclick={() => void onApprove(g.gateId, true)}>Approve</button>
                  <button class="danger" onclick={() => void onApprove(g.gateId, false)}>Deny</button>
                </div>
              </div>
            {/each}
          </div>
        {/if}

        {#if events.length > 0}
          <p class="seclabel">Timeline</p>
          <div class="tl">
            {#each events as ev, i (i)}
              <div class="ev t-{ev.type.replace(/\./g, "_")}">
                <span class="seq">{ev.seq}</span><span class="type">{ev.type}</span>
                <pre>{jsonOf(ev.payload)}</pre>
              </div>
            {/each}
          </div>
        {:else}
          <p class="muted hint">No events yet for this run.</p>
        {/if}
      {/if}
    {/if}
  </div>
</div>

<style>
  .runpane {
    min-height: 0;
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 10px 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .hint {
    font-size: 12.5px;
    margin: 4px 2px;
  }

  .runselp {
    padding: 6px 8px;
    font-size: 12.5px;
    border-radius: 8px;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .pushbtn {
    border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 999px;
    font-size: 12px;
    padding: 4px 10px;
    cursor: pointer;
  }
  .pushbtn:hover {
    border-color: var(--accent);
  }

  .seclabel {
    margin: 2px 2px -2px;
    font-size: 11px;
    font-weight: 600;
    color: var(--fg-faint);
    letter-spacing: 0.05em;
  }

  .gates {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .grow {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .scope {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--fg-dim);
  }

  .scope select {
    width: auto;
    padding: 4px 8px;
  }

  .gate .approve,
  .gate .danger {
    padding: 5px 12px;
    font-size: 12.5px;
  }
</style>