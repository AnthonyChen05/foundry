import {
  FoundryClient,
  type FoundrySocket,
  type ChatSummary,
  type Gate,
  type Message,
  type Run,
  type RunEventItem,
  type SocketStatus,
} from "@foundry/sdk-ts";

/**
 * The web client's single view state over the server-authoritative backend
 * (CLAUDE.md): the SDK sends commands, the store mirrors what events and
 * refetches say, and `sys.resync` triggers a refetch — no local truth.
 *
 * Live event frames flood every connection (the hub broadcasts), so cursors
 * exist for replay; the store keys everything by ids carried in payloads.
 */

const TOKEN_KEY = "foundry.session";

/** Socket status plus the store-only "not connected yet" state. */
export type ConnStatus = SocketStatus | "offline";

export type GateScope = "once" | "session" | "always";

export interface ToolPolicyRow {
  tool: string;
  policy: "ask" | "always" | "session" | "deny";
}

/** A live (still streaming) run's text, keyed by runId. */
interface Draft {
  chatId: string;
  text: string;
}

/** Live-but-not-yet-replayed timeline item (until the full refetch). */
export interface LiveEvent {
  seq: number; // per-channel seq, for display only
  type: string;
  payload: unknown;
  createdAt: string;
  live: true;
}

export interface Notification {
  title: string;
  body: string;
  runId?: string;
  at: number;
}

function baseUrl(): string {
  // Same-origin by design (served by core; vite dev proxies). An explicit
  // backend override only via query string, for pointing a local dev build at
  // a remote core.
  const override = new URLSearchParams(window.location.search).get("backend");
  return override ?? window.location.origin;
}

function readToken(): string | undefined {
  try {
    const v = window.localStorage.getItem(TOKEN_KEY);
    return v !== null && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

function writeToken(token: string | undefined): void {
  try {
    if (token === undefined) window.localStorage.removeItem(TOKEN_KEY);
    else window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // private mode etc. — session-only auth still works
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

const app = $state({
  phase: "boot" as "boot" | "login" | "ready",
  conn: "offline" as ConnStatus,
  connError: "",

  chats: [] as ChatSummary[],
  activeChatId: "",

  /** chatId → messages (canonical OpenAI messages, server truth). */
  messages: {} as Record<string, Message[]>,
  /** runId → streaming draft. */
  drafts: {} as Record<string, Draft>,

  /** runId → run info (stubs ok; full on run.get). */
  runs: {} as Record<string, Run>,
  /** runId → open gates. */
  gates: {} as Record<string, Gate[]>,
  /** runId → replayed run_events. */
  events: {} as Record<string, RunEventItem[]>,
  /** runId → live items not yet covered by a full replay. */
  live: {} as Record<string, LiveEvent[]>,
  /** runIds in first-seen order (newest last). */
  runOrder: [] as string[],
  selectedRunId: "",

  /** Top-level center view: the chat area or the settings screen. */
  view: "chat" as "chat" | "settings",
  /** Right inspector panel (Run / Term / Files), mock-style collapsible. */
  rightOpen: true,
  rightTab: "run" as "run" | "term" | "files",

  notifications: [] as Notification[],
});

// ---------------------------------------------------------------------------
// transport singletons (created on connect)
// ---------------------------------------------------------------------------

let client: FoundryClient | undefined;
let sock: FoundrySocket | undefined;

export function socket(): FoundrySocket {
  if (sock === undefined) throw new Error("not connected");
  return sock;
}

export function rest(): FoundryClient {
  if (client === undefined) throw new Error("not connected");
  return client;
}

// ---------------------------------------------------------------------------
// connect / login
// ---------------------------------------------------------------------------

export async function boot(): Promise<void> {
  const token = readToken();
  if (token === undefined) {
    app.phase = "login";
    return;
  }
  await connect(token).catch(() => {
    // connect() already reset state on auth failure; surface generic errors.
    if (app.phase !== "ready") app.phase = "login";
  });
}

export async function loginWithKey(apiKey: string): Promise<void> {
  app.connError = "";
  const c = new FoundryClient({ baseUrl: baseUrl() });
  try {
    const res = await c.login(apiKey.trim());
    writeToken(res.sessionToken);
    await connect(res.sessionToken);
  } catch (err) {
    app.connError = err instanceof Error ? err.message : String(err);
  }
}

export function logout(): void {
  writeToken(undefined);
  sock?.close();
  sock = undefined;
  client = undefined;
  app.chats = [];
  app.messages = {};
  app.runs = {};
  app.gates = {};
  app.events = {};
  app.live = {};
  app.drafts = {};
  app.runOrder = [];
  app.activeChatId = "";
  app.selectedRunId = "";
  app.view = "chat";
  app.rightOpen = true;
  app.rightTab = "run";
  app.notifications = [];
  app.conn = "offline";
  app.phase = "login";
}

async function connect(token: string): Promise<void> {
  client = client ?? new FoundryClient({ baseUrl: baseUrl() });
  client.setToken(token);
  const s = client.socket({ autoReconnect: true, clientKind: "web", clientVersion: "0.1.0" });
  sock = s;
  s.onStatus = (status) => {
    app.conn = status;
  };
  s.onResync = (channel) => void refetchChannel(channel);
  s.on(handleEvent);
  app.conn = "connecting";
  try {
    await s.connect();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/invalid token|unauthorized/i.test(msg)) {
      // Stale or revoked token: forget it and go back to the login gate.
      writeToken(undefined);
      client = undefined;
      sock = undefined;
      app.conn = "offline";
      app.phase = "login";
      return;
    }
    app.connError = msg;
    app.phase = "login";
    return;
  }
  app.phase = "ready";
  await refreshChats();
}

// ---------------------------------------------------------------------------
// event intake
// ---------------------------------------------------------------------------

function chatOf(channel: string): string {
  return channel.startsWith("chat:") ? channel.slice(5) : "";
}

function handleEvent(event: string, channel: string, seq: number, payload: unknown): void {
  const p = payload as Record<string, unknown>;
  switch (event) {
    case "chat.delta": {
      // Flat payload per protocol.md §1.4: { runId, delta: string }.
      const runId = typeof p["runId"] === "string" ? p["runId"] : "";
      const delta = typeof p["delta"] === "string" ? p["delta"] : "";
      if (runId === "" || delta.length === 0) return;
      const chatId = chatOf(channel);
      const draft = app.drafts[runId];
      if (draft === undefined) {
        if (chatId === "") return;
        app.drafts[runId] = { chatId, text: delta };
      } else {
        draft.text += delta;
      }
      return;
    }
    case "chat.final": {
      const message = p["message"] as Message | undefined;
      const chatId = chatOf(channel);
      if (message !== undefined && chatId !== "") {
        const list = app.messages[chatId];
        if (list === undefined) app.messages[chatId] = [message];
        else list.push(message);
      }
      for (const [runId, d] of Object.entries(app.drafts)) {
        if (d.chatId === chatId) delete app.drafts[runId];
      }
      return;
    }
    case "run.status": {
      const runId = typeof p["runId"] === "string" ? p["runId"] : "";
      const status = typeof p["status"] === "string" ? p["status"] : "";
      if (runId === "" || status === "") return;
      noteRun(runId);
      const run = app.runs[runId];
      if (run === undefined) {
        app.runs[runId] = { id: runId, status: status as Run["status"], trigger: "chat", model: "", budgets: { maxSteps: 0, maxTokens: 0, maxCostUsd: 0, maxWallMs: 0 }, createdAt: nowIso() };
      } else {
        run.status = status as Run["status"];
        if (typeof p["error"] === "string") run.error = p["error"];
        else delete run.error;
      }
      if (status === "waiting_approval") void refreshRun(runId);
      if (status === "done" || status === "failed" || status === "cancelled" || status === "timeout") {
        delete app.drafts[runId];
        // Terminal state: replace optimistic live items with server truth.
        void refreshRunEvents(runId);
      }
      return;
    }
    case "run.gate_request": {
      // Payload IS the §3 Gate shape.
      const gate = payload as Gate;
      if (typeof gate["gateId"] !== "string" || gate["gateId"] === "") return;
      noteRun(gate["runId"]);
      addLive(gate["runId"], event, seq, payload);
      // An approval is actionable now: surface the inspector even if it was
      // closed (and leave settings if it hid the chat).
      app.view = "chat";
      app.rightOpen = true;
      app.rightTab = "run";
      const list = app.gates[gate["runId"]] ?? [];
      if (!list.some((g) => g.gateId === gate["gateId"])) {
        list.push(gate);
        app.gates[gate["runId"]] = list;
      }
      return;
    }
    case "run.gate_resolved": {
      const runId = channel.startsWith("run:") ? channel.slice(4) : "";
      const gateId = typeof p["gateId"] === "string" ? p["gateId"] : "";
      if (runId === "") return;
      addLive(runId, event, seq, payload);
      const list = app.gates[runId];
      if (list !== undefined && gateId !== "") {
        const kept = list.filter((g) => g.gateId !== gateId);
        if (kept.length === 0) delete app.gates[runId];
        else app.gates[runId] = kept;
      }
      return;
    }
    case "run.tool_call":
    case "run.tool_result":
    case "run.usage": {
      const runId = channel.startsWith("run:") ? channel.slice(4) : "";
      if (runId === "") return;
      noteRun(runId);
      addLive(runId, event, seq, payload);
      return;
    }
    case "notify.push": {
      app.notifications.push({
        title: typeof p["title"] === "string" ? p["title"] : "",
        body: typeof p["body"] === "string" ? p["body"] : "",
        runId: typeof p["runId"] === "string" ? p["runId"] : undefined,
        at: Date.now(),
      });
      if (app.notifications.length > 20) app.notifications.shift();
      return;
    }
    default:
      return;
  }
}

function noteRun(runId: string): void {
  if (!app.runOrder.includes(runId)) app.runOrder.push(runId);
  // Auto-follow: the timeline shows the newest run of the active chat.
  const run = app.runs[runId];
  const chatId = run?.conversationId;
  if (app.selectedRunId === "" && (chatId === undefined || chatId === app.activeChatId)) {
    app.selectedRunId = runId;
  }
}

function addLive(runId: string, type: string, seq: number, payload: unknown): void {
  const list = app.live[runId] ?? [];
  list.push({ seq, type, payload, createdAt: nowIso(), live: true });
  if (list.length > 400) list.shift();
  app.live[runId] = list;
}

// ---------------------------------------------------------------------------
// refetches (sys.resync + event-driven)
// ---------------------------------------------------------------------------

async function refetchChannel(channel: string): Promise<void> {
  if (channel.startsWith("chat:")) {
    const chatId = chatOf(channel);
    await refreshChats();
    if (chatId !== "" && app.messages[chatId] !== undefined) await refreshMessages(chatId);
    return;
  }
  if (channel.startsWith("run:")) {
    const runId = channel.slice(4);
    await refreshRun(runId);
    await refreshRunEvents(runId);
    return;
  }
}

export async function refreshChats(): Promise<void> {
  try {
    app.chats = await socket().chatList();
  } catch (err) {
    app.connError = err instanceof Error ? err.message : String(err);
  }
}

export async function refreshMessages(chatId: string): Promise<void> {
  app.messages[chatId] = await socket().chatHistory({ chatId });
}

async function refreshRun(runId: string): Promise<void> {
  const run = await socket().runGet({ runId });
  app.runs[runId] = run;
  if (run.gates === undefined || run.gates.length === 0) {
    if (app.gates[runId]?.length) delete app.gates[runId];
  } else {
    app.gates[runId] = run.gates;
  }
  if (run.conversationId !== undefined && run.conversationId !== "" && app.messages[run.conversationId] !== undefined) {
    // Tool messages and the final assistant message land server-side.
    await refreshMessages(run.conversationId);
  }
}

async function refreshRunEvents(runId: string): Promise<void> {
  try {
    const items = await socket().runEvents({ runId, since: 0 });
    app.events[runId] = items;
    delete app.live[runId];
  } catch {
    // run may not be visible yet — live frames still show
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export async function selectChat(chatId: string): Promise<void> {
  app.activeChatId = chatId;
  if (app.messages[chatId] === undefined) await refreshMessages(chatId);
}

export async function createChat(title?: string): Promise<void> {
  const chat = await socket().chatCreate(title !== undefined && title.length > 0 ? { title } : {});
  app.chats = [chat, ...app.chats.filter((c) => c.id !== chat.id)];
  await selectChat(chat.id);
}

/** Compose one idempotent command key per send. */
export function idem(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function send(chatId: string, content: string, agent: boolean, policy: ToolPolicyRow[], model?: string): Promise<void> {
  const toolPolicy = policy.length === 0
    ? undefined
    : Object.fromEntries(policy.filter((r) => r.tool.trim().length > 0).map((r) => [r.tool.trim(), r.policy]));
  const res = await socket().chatSend(
    {
      chatId,
      content,
      model,
      agent: agent ? { enabled: true, toolPolicy } : undefined,
    },
    idem("chat"),
  );
  const runId = res.runId;
  noteRun(runId);
  app.runs[runId] = {
    id: runId,
    conversationId: chatId,
    status: "queued",
    trigger: "chat",
    model: model ?? app.chats.find((c) => c.id === chatId)?.model ?? "",
    budgets: { maxSteps: 0, maxTokens: 0, maxCostUsd: 0, maxWallMs: 0 },
    createdAt: nowIso(),
  };
  app.live[runId] = [];
  app.selectedRunId = runId;
}

export async function cancelRun(runId: string): Promise<void> {
  await socket().runCancel({ runId }, idem("cancel"));
}

export async function resolveGate(runId: string, gateId: string, approve: boolean, scope: GateScope): Promise<void> {
  if (!approve) {
    await socket().runApprove({ runId, gateId, approve: false }, idem("gate"));
    return;
  }
  await socket().runApprove({ runId, gateId, approve: true, ...(scope !== "once" ? { scope } : {}) }, idem("gate"));
}

// ---------------------------------------------------------------------------
// derived views (plain functions — reactive when read inside components)
// ---------------------------------------------------------------------------

/** Streaming drafts of a chat, keyed by runId (for tool meta rows while live). */
export function draftsFor(chatId: string): { runId: string; text: string }[] {
  return Object.entries(app.drafts)
    .filter(([, d]) => d.chatId === chatId)
    .map(([runId, d]) => ({ runId, text: d.text }));
}

/** Live-only events of a run (streaming transcript rows before replay). */
export function liveFor(runId: string): LiveEvent[] {
  return app.live[runId] ?? [];
}

export function gatesFor(runId: string): Gate[] {
  return app.gates[runId] ?? [];
}

export function timelineFor(runId: string): (RunEventItem | LiveEvent)[] {
  return [...(app.events[runId] ?? []), ...(app.live[runId] ?? [])];
}

export function setView(view: "chat" | "settings"): void {
  app.view = view;
}

/** Show the right inspector, optionally switching its tab. */
export function openRight(tab?: "run" | "term" | "files"): void {
  app.rightOpen = true;
  if (tab !== undefined) app.rightTab = tab;
}

/** Toggle the right inspector; clicking the active tab closes it. */
export function toggleRight(tab?: "run" | "term" | "files"): void {
  if (app.rightOpen && (tab === undefined || app.rightTab === tab)) app.rightOpen = false;
  else openRight(tab);
}

export function runsOfChat(chatId: string): Run[] {
  return app.runOrder
    .map((id) => app.runs[id])
    .filter((r): r is Run => r !== undefined && r.conversationId === chatId)
    .reverse();
}

export function latestRunOfChat(chatId: string): Run | undefined {
  const runs = runsOfChat(chatId);
  return runs[0];
}

export function chatById(chatId: string): ChatSummary | undefined {
  return app.chats.find((c) => c.id === chatId);
}

export type { ChatSummary, Gate, Message, Run, RunEventItem, SocketStatus };
export { app };