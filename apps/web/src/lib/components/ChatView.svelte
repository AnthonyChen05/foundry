<script lang="ts">
  import type { ToolCall } from "@foundry/sdk-ts";
  import {
    activeChatBinding,
    app,
    chatById,
    createChat,
    draftsFor,
    gatesFor,
    liveFor,
    rest,
    runsOfChat,
    selectChat,
    send,
    toggleRight,
    openRight,
    type ToolPolicyRow,
    type Message,
  } from "$lib/foundry.svelte";

  const POLICIES = ["ask", "always", "session", "deny"] as const;

  let models = $state<{ id: string; name: string; avatar?: string }[]>([]);
  let modelChoice = $state("");
  let menuOpen = $state(false);
  let agent = $state(false);
  let showTools = $state(false);
  /** Where tool calls run (ADR-015): default = the chat's current binding. */
  let location = $state<"local" | "cloud">("cloud");
  let policyRows = $state<ToolPolicyRow[]>([]);
  let text = $state("");
  let busy = $state(false);
  let sendError = $state("");

  let scroller = $state<HTMLDivElement | undefined>(undefined);
  let ta = $state<HTMLTextAreaElement | undefined>(undefined);
  let copied = $state<Record<string, boolean>>({});

  $effect(() => {
    if (models.length === 0) {
      rest()
        .models()
        .then((res) => {
          models = res.data.map((m) => ({ id: m.id, name: m.name, ...(m.avatar !== undefined ? { avatar: m.avatar } : {}) }));
        })
        .catch(() => {
          /* picker stays empty */
        });
    }
  });

  // First usable chat becomes active automatically.
  $effect(() => {
    if (app.activeChatId === "" && app.chats.length > 0) {
      void selectChat(app.chats[0].id);
    }
  });

  const messages = $derived(app.messages[app.activeChatId] ?? []);
  const drafts = $derived(draftsFor(app.activeChatId));
  const chatTitle = $derived(chatById(app.activeChatId)?.title ?? "Untitled");
  const chatModel = $derived(chatById(app.activeChatId)?.model ?? "");
  const displayModelId = $derived(modelChoice !== "" ? modelChoice : chatModel);

  const openGates = $derived(runsOfChat(app.activeChatId).reduce((n, r) => n + gatesFor(r.id).length, 0));

  // Track content depth, not the arrays themselves (they mutate in place).
  $effect(() => {
    void messages.length;
    const draftLens = drafts.map((d) => d.text.length).join(":");
    const el = scroller;
    if (el === undefined) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  });

  // Follow the active chat's binding: a "local" chat preselects local; a chat
  // pushed to the cloud flips back to cloud.
  $effect(() => {
    const bind = activeChatBinding();
    if (bind.location !== undefined) location = bind.location;
  });

  async function submit(): Promise<void> {
    const chatId = app.activeChatId;
    const content = text.trim();
    if (chatId === "" || content.length === 0 || busy) return;
    app.view = "chat";
    busy = true;
    sendError = "";
    try {
      await send(chatId, content, agent, policyRows, modelChoice === "" ? undefined : modelChoice, location);
      text = "";
      if (ta !== undefined) ta.style.height = "";
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  function addRow(): void {
    policyRows.push({ tool: "", policy: "ask" });
  }

  function dropRow(i: number): void {
    policyRows.splice(i, 1);
  }

  function modelLabel(id: string): string {
    const m = models.find((x) => x.id === id);
    if (m === undefined) return id;
    return `${m.avatar ?? ""}${m.avatar !== undefined && m.avatar.length > 0 ? " " : ""}${m.name.length > 0 ? m.name : id}`;
  }

  function pickModel(id: string): void {
    modelChoice = id;
    menuOpen = false;
  }

  function toClip(key: string, value: string): void {
    copied = { ...copied, [key]: true };
    setTimeout(() => {
      const next = { ...copied };
      delete next[key];
      copied = next;
    }, 1200);
    void navigator.clipboard.writeText(value).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Transcript view model: tool messages fold into the assistant turn that
  // requested them (mock-style collapsible meta rows).
  // ---------------------------------------------------------------------------

  interface ToolRow {
    name: string;
    args: string;
    result: string | undefined;
    ok: boolean | undefined;
  }

  interface Item {
    i: number;
    role: "user" | "assistant";
    text: string;
    tools: ToolRow[];
  }

  function safeJson(v: unknown): string {
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v) ?? "";
    } catch {
      return String(v);
    }
  }

  function contentOf(m: Message): string {
    const c: unknown = m.content;
    if (typeof c === "string") return c;
    if (c === undefined || c === null) return "";
    if (Array.isArray(c)) {
      return c
        .map((p) => {
          if (typeof p === "object" && p !== null && "text" in p && typeof (p as { text: unknown }).text === "string") {
            return (p as { text: string }).text;
          }
          return "";
        })
        .filter((s) => s.length > 0)
        .join("\n");
    }
    return JSON.stringify(c, null, 1);
  }

  function buildItems(msgs: Message[]): Item[] {
    const out: Item[] = [];
    const pending = new Map<string, ToolRow>();
    msgs.forEach((m, i) => {
      if (m.role === "tool") {
        const row = typeof m.tool_call_id === "string" ? pending.get(m.tool_call_id) : undefined;
        if (row !== undefined) {
          row.result = safeJson((m.content as unknown) ?? "");
          row.ok = true; // a stored tool message is a completed call
        }
        return;
      }
      const role = m.role === "user" ? "user" : "assistant";
      const item: Item = { i, role, text: contentOf(m), tools: [] };
      if (m.role === "assistant" && m.tool_calls !== undefined) {
        for (const tc of m.tool_calls as ToolCall[]) {
          const row: ToolRow = { name: tc.function.name, args: tc.function.arguments, result: undefined, ok: undefined };
          item.tools.push(row);
          pending.set(tc.id, row);
        }
      }
      out.push(item);
    });
    return out;
  }

  const items = $derived(buildItems(messages));

  /** Live tool meta rows for a streaming draft. */
  function liveRows(runId: string): ToolRow[] {
    const byId = new Map<string, ToolRow>();
    const rows: ToolRow[] = [];
    for (const ev of liveFor(runId)) {
      if (ev.type !== "run.tool_call" && ev.type !== "run.tool_result") continue;
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      if (ev.type === "run.tool_call") {
        const call = (typeof p["call"] === "object" && p["call"] !== null ? p["call"] : {}) as Record<string, unknown>;
        const row: ToolRow = {
          name: typeof call["name"] === "string" ? call["name"] : "tool",
          args: typeof call["args"] === "string" ? call["args"] : safeJson(call["args"]),
          result: undefined,
          ok: undefined,
        };
        if (typeof call["id"] === "string") byId.set(call["id"], row);
        rows.push(row);
      } else if (typeof p["id"] === "string") {
        const row = byId.get(p["id"]);
        if (row !== undefined) {
          row.result = safeJson(p["content"]);
          row.ok = p["ok"] !== false;
        }
      }
    }
    return rows;
  }

  function snippet(s: string, max = 72): string {
    const one = s.replaceAll(/\s+/g, " ").trim();
    return one.length > max ? one.slice(0, max) + "…" : one;
  }

  // ---------------------------------------------------------------------------
  // Tiny markdown: paragraphs, fenced code cards, inline code/bold. Escape
  // FIRST, then transform — user content never reaches {@html} raw.
  // ---------------------------------------------------------------------------

  type Block = { kind: "para"; html: string } | { kind: "code"; lang: string; text: string };

  function esc(s: string): string {
    return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }

  function inlineMd(src: string): string {
    let h = esc(src);
    h = h.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    h = h.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    return h;
  }

  function toParas(src: string): Block[] {
    return src
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p): Block => ({ kind: "para", html: "<p>" + inlineMd(p).replaceAll("\n", "<br>") + "</p>" }));
  }

  function stripBlocks(text: string): Block[] {
    const out: Block[] = [];
    const re = /```([A-Za-z0-9_#+.-]*)[ \t]*\r?\n?([\s\S]*?)(?:```|$)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push(...toParas(text.slice(last, m.index)));
      out.push({ kind: "code", lang: (m[1] ?? "").trim(), text: (m[2] ?? "").replace(/\n$/, "") });
      last = re.lastIndex;
    }
    if (last < text.length) out.push(...toParas(text.slice(last)));
    return out;
  }
</script>

<div class="pane chatpane">
  <!-- header ------------------------------------------------------------ -->
  <header class="topbar">
    <div class="modelwrap">
      <button class="model-btn" onclick={() => (menuOpen = !menuOpen)} aria-haspopup="menu" aria-expanded={menuOpen}>
        <span class="mname">{modelChoice !== "" ? modelLabel(modelChoice) : chatModel !== "" ? modelLabel(chatModel) : "Foundry"}</span>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M4.5 6.5 8 10l3.5-3.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" />
        </svg>
      </button>
      {#if menuOpen}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="backdrop" onclick={() => (menuOpen = false)}></div>
        <div class="menu" role="menu">
          <button role="menuitem" onclick={() => pickModel("")} class:check={modelChoice === ""}>
            <span>Provider default</span>
            <div class="grow"></div>
            {#if modelChoice === ""}<span class="tick">✓</span>{/if}
          </button>
          {#each models as m (m.id)}
            <button role="menuitem" onclick={() => pickModel(m.id)} class:check={modelChoice === m.id}>
              <span>{m.avatar ?? ""}{m.avatar !== undefined && m.avatar.length > 0 ? " " : ""}{m.name}</span>
              <span class="mid">{m.id}</span>
              {#if modelChoice === m.id}<span class="tick">✓</span>{/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <span class="sep">/</span>
    <span class="title">{chatTitle}</span>
    <div class="spacer"></div>
    {#if openGates > 0}
      <button class="chip warn" onclick={() => openRight("run")}>{openGates} awaiting approval</button>
    {/if}
    <span class="conn" title={`connection: ${app.conn}`}><span class="dot {app.conn}"></span></span>
    <button class="icon-btn" class:on={app.rightOpen} title="Inspector — runs, terminal, files" aria-label="Toggle inspector" onclick={() => toggleRight()}>
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <rect x="2" y="3" width="12" height="10.5" rx="2" stroke="currentColor" stroke-width="1.3" fill="none" />
        <path d="M10.2 3v10.5" stroke="currentColor" stroke-width="1.3" />
      </svg>
    </button>
  </header>

  <!-- transcript --------------------------------------------------------- -->
  <div class="scroll" bind:this={scroller}>
    <div class="col">
      {#if app.activeChatId === ""}
        <div class="hero">
          <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
            <path d="M12 2.6 13.7 10.3 21.4 12 13.7 13.7 12 21.4 10.3 13.7 2.6 12 10.3 10.3Z" fill="var(--accent)" />
          </svg>
          <h2>What are we shipping?</h2>
          <p class="muted">Responses stream here; agent tool calls run sandboxed and gated calls wait for your approval in the inspector.</p>
          <button class="newhere" onclick={() => void createChat()}>Start a chat</button>
        </div>
      {:else}
        {#each items as it (it.i)}
          {#if it.role === "user"}
            <div class="msg user">
              <div class="bubble">{it.text}</div>
            </div>
          {:else}
            <article class="msg assistant">
              <div class="ahead">
                <span class="sp" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="11" height="11">
                    <path d="M12 2.6 13.7 10.3 21.4 12 13.7 13.7 12 21.4 10.3 13.7 2.6 12 10.3 10.3Z" fill="currentColor" />
                  </svg>
                </span>
                <span class="a-n">{displayModelId !== "" ? modelLabel(displayModelId) : "Foundry"}</span>
              </div>
              {#each stripBlocks(it.text) as b, bi (bi)}
                {#if b.kind === "code"}
                  <div class="codecard">
                    <header>
                      <span class="codelang">{b.lang || "text"}</span>
                      <div class="grow"></div>
                      <button class="copybtn" onclick={() => toClip(`c${it.i}-${bi}`, b.text)}>
                        {copied[`c${it.i}-${bi}`] === true ? "Copied" : "Copy"}
                      </button>
                    </header>
                    <pre><code>{b.text}</code></pre>
                  </div>
                {:else}
                  {@html b.html}
                {/if}
              {/each}
              {#each it.tools as tr, ti (ti)}
                <details class="toolrow">
                  <summary>
                    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                      <path d="M3 3l3.5 3.5M3 3v3M3 3h3M13 13l-3.5-3.5M13 13v-3M13 13h-3" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" />
                    </svg>
                    <span class="tname">{tr.name}</span>
                    <span class="targs">{snippet(tr.args)}</span>
                    {#if tr.result !== undefined}
                      <span class="tstate" class:bad={tr.ok === false}>→ done</span>
                    {/if}
                  </summary>
                  <pre>{tr.args}{tr.result !== undefined ? `\n\n→ ${tr.result}` : ""}</pre>
                </details>
              {/each}
              <div class="actrow">
                {#if it.text.length > 0}
                  <button class="icon-btn" title="Copy" aria-label="Copy message" onclick={() => toClip(`m${it.i}`, it.text)}>
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                      {#if copied[`m${it.i}`] === true}
                        <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" />
                      {:else}
                        <rect x="5.5" y="5.5" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none" />
                        <path d="M10.5 5.5v-1a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1" stroke="currentColor" stroke-width="1.2" fill="none" />
                      {/if}
                    </svg>
                  </button>
                {/if}
              </div>
            </article>
          {/if}
        {/each}

        {#each drafts as d (d.runId)}
          <article class="msg assistant live">
            <div class="ahead">
              <span class="sp" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="11" height="11">
                  <path d="M12 2.6 13.7 10.3 21.4 12 13.7 13.7 12 21.4 10.3 13.7 2.6 12 10.3 10.3Z" fill="currentColor" />
                </svg>
              </span>
              <span class="a-n">{displayModelId !== "" ? modelLabel(displayModelId) : "Foundry"}</span>
              <span class="dim">streaming…</span>
            </div>
            {#each stripBlocks(d.text) as b, bi (bi)}
              {#if b.kind === "code"}
                <div class="codecard">
                  <header><span class="codelang">{b.lang || "text"}</span></header>
                  <pre><code>{b.text}</code></pre>
                </div>
              {:else}
                {@html b.html}
              {/if}
            {/each}
            <p class="caret"><span class="streaming"></span></p>
            {#each liveRows(d.runId) as tr, ti (ti)}
              <div class="toolrow static">
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                  <path d="M3 3l3.5 3.5M3 3v3M3 3h3M13 13l-3.5-3.5M13 13v-3M13 13h-3" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" />
                </svg>
                <span class="tname">{tr.name}</span>
                <span class="targs">{snippet(tr.args)}</span>
                <span class="tstate">{tr.ok === true ? "→ done" : tr.ok === false ? "→ failed" : "→ running…"}</span>
              </div>
            {/each}
          </article>
        {/each}
      {/if}
    </div>
  </div>

  <!-- composer ----------------------------------------------------------- -->
  <div class="foot">
    {#if app.activeChatId !== ""}
      <div class="composer">
        {#if agent && showTools}
          <div class="policy">
            <p class="polhint">Tool policy sent with this message — sandboxed tools only; "ask" opens a gate.</p>
            {#each policyRows as row, i}
              <div class="prow">
                <input placeholder="shell" bind:value={row.tool} spellcheck="false" />
                <select bind:value={row.policy}>
                  {#each POLICIES as p}
                    <option value={p}>{p}</option>
                  {/each}
                </select>
                <button class="icon-btn" onclick={() => dropRow(i)} title="Remove rule" aria-label="Remove rule">✕</button>
              </div>
            {/each}
            <button class="addrule" onclick={addRow}>+ rule</button>
          </div>
        {/if}
        <textarea
          rows="1"
          placeholder="Message {displayModelId !== "" ? modelLabel(displayModelId) : "foundry"}…"
          bind:value={text}
          bind:this={ta}
          onkeydown={onKey}
          oninput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
          }}
          disabled={busy}
        ></textarea>
        <div class="crow">
          <button class="chip" class:on={agent} onclick={() => (agent = !agent)} title="Enable sandboxed agent tool calls">
            <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <path d="M12 2.6 13.7 10.3 21.4 12 13.7 13.7 12 21.4 10.3 13.7 2.6 12 10.3 10.3Z" fill="currentColor" />
            </svg>
            Agent
          </button>
          {#if agent}
            <button class="chip" class:on={showTools} onclick={() => (showTools = !showTools)}>
              Tools{policyRows.length > 0 ? ` · ${policyRows.length}` : ""}
            </button>
            {#if app.executor?.online !== true}
              <span class="chip" style="color: var(--fg-faint)" title="The desktop's local sandbox runner is offline — Local location is unavailable">
                Local sandbox: offline
              </span>
            {/if}
            <select class="chip chip-select" bind:value={location} aria-label="Execution location">
              <option value="cloud">Cloud (backend sandbox)</option>
              <option value="local" disabled={app.executor?.online !== true || app.executor?.dockerAvailable === false}>
                Local {app.executor?.dockerAvailable === false ? "(no Docker)" : app.executor?.online === true ? "" : "(offline)"}
              </option>
            </select>
          {/if}
          {#if sendError !== ""}
            <span class="error-text serror">{sendError}</span>
          {/if}
          <div class="grow"></div>
          <button class="sendbtn" onclick={() => void submit()} disabled={busy || text.trim().length === 0} aria-label="Send message" title="Send (Enter)">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path d="M8 12.5V4M4.5 7 8 3.5 11.5 7" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
      </div>
      <p class="disclaimer">Runs execute in a sandbox · gated tool calls wait for your approval · Enter to send, Shift+Enter for a newline</p>
    {/if}
  </div>
</div>

<style>
  .chatpane {
    min-height: 0;
  }

  /* header */
  .topbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    flex: none;
    min-height: 52px;
    background: var(--bg);
  }

  .modelwrap {
    position: relative;
  }

  .model-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: none;
    padding: 6px 8px;
    font-size: 14.5px;
    font-weight: 700;
    border-radius: 8px;
  }

  .model-btn:hover {
    background: var(--bg-overlay);
  }

  .grow {
    flex: 1;
  }

  .mname {
    max-width: 240px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 5;
  }

  .menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 6;
    min-width: 260px;
    max-height: 320px;
    overflow-y: auto;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 6px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .menu button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    background: transparent;
    border: none;
    text-align: left;
    padding: 7px 10px;
    border-radius: 8px;
    font-size: 13.5px;
  }

  .menu button:hover {
    background: var(--bg-overlay);
  }

  .menu .mid {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--fg-faint);
  }

  .menu .tick {
    color: var(--accent);
  }

  .sep {
    color: var(--fg-faint);
  }

  .title {
    color: var(--fg-dim);
    font-size: 13.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 40%;
  }

  .conn {
    display: inline-flex;
    align-items: center;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: 999px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg-dim);
    font-size: 12.5px;
    padding: 4px 12px;
  }

  .chip:hover {
    color: var(--fg);
    border-color: var(--fg-faint);
  }

  .chip.on {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
    background: var(--accent-soft);
  }

  .chip.warn {
    color: var(--warn);
    border-color: color-mix(in srgb, var(--warn) 55%, transparent);
    background: color-mix(in srgb, var(--warn) 10%, transparent);
  }

  /* execution-location select styled as a chip (ADR-015) */
  .chip-select {
    background: var(--bg);
    cursor: pointer;
    padding: 4px 8px;
  }
  .chip-select:focus {
    outline: 2px solid var(--accent);
    border-color: transparent;
  }
  .chip-select:disabled {
    color: var(--fg-faint);
    cursor: not-allowed;
  }

  /* transcript */
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .col {
    width: min(820px, calc(100% - 32px));
    margin: 0 auto;
    padding: 26px 0 24px;
    display: flex;
    flex-direction: column;
  }

  .msg.user {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 22px;
  }

  .msg.user .bubble {
    max-width: 78ch;
    font-size: 14.5px;
    line-height: 1.55;
  }

  .msg.assistant {
    margin-bottom: 26px;
    font-size: 15.5px;
    line-height: 1.65;
  }

  .ahead {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }

  .sp {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--accent-soft);
    color: var(--accent);
    flex: none;
  }

  .a-n {
    font-weight: 700;
    font-size: 14px;
  }

  .dim,
  .caret .streaming {
    color: var(--fg-faint);
  }

  .caret {
    margin: 2px 0 4px;
  }

  .msg.assistant :global(p) {
    margin: 0 0 14px;
  }

  .msg.assistant :global(p:last-child) {
    margin-bottom: 0;
  }

  .msg.assistant :global(code) {
    background: var(--bg-raised);
    border: 1px solid var(--border-soft);
    border-radius: 5px;
    padding: 1px 5px;
    font-size: 13px;
  }

  .codecard {
    background: var(--bg-raised);
    border: 1px solid var(--border-soft);
    border-radius: 12px;
    margin: 4px 0 14px;
    overflow: hidden;
  }

  .codecard header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 13px;
    border-bottom: 1px solid var(--border-soft);
  }

  .codelang {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--fg-faint);
  }

  .copybtn {
    background: transparent;
    border: none;
    color: var(--fg-dim);
    font-size: 12px;
    padding: 2px 6px;
    cursor: pointer;
  }

  .copybtn:hover {
    color: var(--fg);
  }

  .codecard pre {
    background: transparent;
    border: none;
    border-radius: 0;
    margin: 0;
    padding: 12px 14px;
    font-size: 13px;
  }

  .toolrow {
    margin: 4px 0;
    font-size: 12.5px;
    color: var(--fg-dim);
  }

  .toolrow summary {
    display: flex;
    align-items: center;
    gap: 8px;
    list-style: none;
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 8px;
  }

  .toolrow summary::-webkit-details-marker {
    display: none;
  }

  .toolrow summary:hover {
    background: var(--bg-overlay);
  }

  .toolrow.static {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
  }

  .toolrow svg {
    flex: none;
    color: var(--accent);
  }

  .tname {
    font-weight: 600;
    color: var(--fg);
    font-size: 12.5px;
  }

  .targs {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--fg-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .tstate {
    color: var(--fg-faint);
    font-size: 11.5px;
    flex: none;
  }

  .tstate.bad {
    color: var(--err);
  }

  .toolrow pre {
    margin: 4px 24px 8px;
    padding: 8px 10px;
    max-height: 200px;
  }

  .actrow {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 6px;
    opacity: 0.85;
  }

  /* empty hero */
  .hero {
    margin: auto 0;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 64px 12px;
  }

  .hero h2 {
    margin: 6px 0 0;
    font-size: 22px;
  }

  .hero p {
    max-width: 46ch;
    margin: 0;
    font-size: 13.5px;
  }

  .newhere {
    margin-top: 10px;
  }

  /* composer */
  .foot {
    flex: none;
    padding: 6px 16px 14px;
  }

  .composer {
    width: min(820px, 100%);
    margin: 0 auto;
    background: var(--bg-raised);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-lg);
    padding: 10px 12px 8px 16px;
  }

  .composer textarea {
    background: transparent;
    border: none;
    min-height: 27px;
    max-height: 220px;
    resize: none;
    font: inherit;
    font-size: 15px;
    padding: 10px 0 8px;
  }

  .composer textarea:focus {
    outline: none;
  }

  .crow {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .serror {
    font-size: 12px;
    max-width: 260px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sendbtn {
    width: 34px;
    height: 34px;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-fg);
    padding: 0;
  }

  .sendbtn:hover:not(:disabled) {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }

  .disclaimer {
    width: min(820px, 100%);
    margin: 8px auto 0;
    text-align: center;
    font-size: 11.5px;
    color: var(--fg-faint);
  }

  /* policy editor inside the composer card */
  .policy {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 2px 8px;
    border-bottom: 1px solid var(--border-soft);
    margin-bottom: 4px;
    font-size: 12.5px;
  }

  .polhint {
    margin: 0;
    color: var(--fg-faint);
    font-size: 11.5px;
  }

  .prow {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .prow input {
    max-width: 220px;
    padding: 4px 8px;
  }

  .prow select {
    max-width: 120px;
    padding: 4px 8px;
    width: auto;
  }

  .addrule {
    align-self: flex-start;
    background: transparent;
    border: none;
    color: var(--accent);
    font-size: 12.5px;
    cursor: pointer;
    padding: 2px 4px;
  }
</style>