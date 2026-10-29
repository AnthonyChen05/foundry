import type { Message } from "@foundry/protocol";
import type { RunBudgets } from "@foundry/protocol";
import type { RunStatusValue } from "@foundry/protocol";
import { eq, inArray, and } from "drizzle-orm";
import type { FoundryDb } from "../db/open.js";
import { conversations, messages, models, runEvents, runs, usage } from "../db/schema.js";
import { adapterFor } from "../providers/registry.js";
import type { ProviderStore } from "../providers/store.js";
import { ulid } from "../util/ulid.js";
import {
  ProviderError,
  type ChatChunk,
  type ChatCompletionRequest,
  type ProviderRecord,
  type ToolChoice,
  type ToolDefinition,
  type Usage,
} from "../providers/types.js";

export const toIso = (ms: number): string => new Date(ms).toISOString();

export type EmitFn = (event: string, channel: string, payload: unknown) => void;

export const DEFAULT_BUDGETS = {
  maxSteps: 25,
  maxTokens: 100_000,
  maxCostUsd: 5,
  maxWallMs: 600_000,
} as const;

/** run_events types (data-model.md). */
export type RunEventType =
  | "status"
  | "delta"
  | "tool_call"
  | "tool_result"
  | "gate_request"
  | "gate_resolved"
  | "usage"
  | "error"
  | "raw_provider_request"
  | "raw_provider_response";

export interface RunChatResult {
  runId: string;
  message: Message & { reasoning_content?: string };
  usage: Usage;
  finishReason: string;
}

interface ResolvedRoute {
  runModelId: string; // catalog id e.g. "dummy/scripted" — or a profile id (mp_…)
  upstreamModel: string; // bare name sent upstream e.g. "scripted"
  provider: ProviderRecord;
  /** A model profile (personality): system prompt + default advanced params. */
  profile?: { systemPrompt: string | null; params: Record<string, unknown> | null };
}

export class UnknownModelError extends ProviderError {
  constructor(model: string) {
    super(`unknown model: ${model} (see GET /v1/models)`, 404);
    this.name = "UnknownModelError";
  }
}

/**
 * The chat pipeline shared by REST and WS planes. Creates a run per request
 * (guardrail #4: every provider request/response stored — keys redacted),
 * streams provider chunks, persists assistant messages, writes usage rows.
 * WS layers channel-event emission on top via `emit`; REST passes a noop.
 */
export class ChatService {
  constructor(
    private readonly dbx: FoundryDb,
    private readonly providerStore: ProviderStore,
  ) {}

  route(wireModel: string): ResolvedRoute {
    // A model PROFILE (mp_…) resolves to its wrapped base with the persona
    // attached; profiles may wrap profiles — the innermost persona wins.
    let profile = this.providerStore.profileById(wireModel);
    let target: string = profile !== undefined ? profile.baseModelId : wireModel;
    for (let depth = 0; depth < 4; depth++) {
      const next = this.providerStore.profileById(target);
      if (next === undefined) break;
      profile = next;
      target = next.baseModelId;
    }
    const resolved = this.providerStore.resolveModel(target);
    if (!resolved) throw new UnknownModelError(target);
    const provider = this.providerStore.record(resolved.providerId, { withKey: true });
    if (!provider || !provider.enabled) throw new UnknownModelError(target);
    const upstreamModel = resolved.modelId.includes("/")
      ? resolved.modelId.split("/").slice(1).join("/")
      : resolved.modelId;
    return {
      runModelId: wireModel,
      upstreamModel,
      provider,
      ...(profile !== undefined
        ? { profile: { systemPrompt: profile.systemPrompt, params: profile.params } }
        : {}),
    };
  }

  /**
   * The profile's persona: PREPEND its system prompt before any existing
   * system turn (the caller's instructions stay in charge; personality sits
   * in front of them, or becomes one when the caller sent none).
   */
  static withSystemPrompt(messages: Message[], systemPrompt: string | null | undefined): Message[] {
    if (systemPrompt === undefined || systemPrompt === null || systemPrompt.trim().length === 0) return messages;
    // The persona: PREPEND it (the system turn sits first when the caller
    // sent none — OpenAI's convention — and rides ahead of an existing turn).
    const copy = [...messages];
    const at = copy.findIndex((m) => m.role === "system");
    if (at >= 0 && typeof copy[at]?.content === "string") {
      const existing = copy[at] as { role: "system"; content: string };
      copy[at] = { role: "system", content: `${systemPrompt}\n\n${existing.content}` };
    } else {
      copy.unshift({ role: "system", content: systemPrompt });
    }
    return copy;
  }

  /** Assemble OpenAI stream deltas into a canonical message + usage. */
  static assemble(chunks: ChatChunk[]): {
    message: Message & { reasoning_content?: string };
    finishReason: string;
    usage: Usage | undefined;
  } {
    let content = "";
    let reasoning = "";
    const toolCalls = new Map<number, { id: string; type: "function"; function: { name: string; arguments: string } }>();
    let finishReason = "stop";
    let usage: Usage | undefined;
    for (const c of chunks) {
      for (const choice of c.choices) {
        const d = choice.delta ?? {};
        if (typeof d.content === "string") content += d.content;
        if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
        for (const tc of d.tool_calls ?? []) {
          const existing = toolCalls.get(tc.index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.function.name += tc.function.name;
          if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
          toolCalls.set(tc.index, existing);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
      if (c.usage) usage = c.usage;
    }
    const message: Message & { reasoning_content?: string } = { role: "assistant", content };
    if (reasoning.length > 0) message.reasoning_content = reasoning;
    if (toolCalls.size > 0) {
      message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    }
    return { message, finishReason, usage };
  }

  private nextSeq(table: "run_events" | "messages", where: string, key: string): number {
    const row = this.dbx.sqlite
      .prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM ${table} WHERE ${where} = ?`)
      .get(key) as { next: number };
    return row.next;
  }

  private appendRunEvent(runId: string, type: RunEventType, payload: unknown): void {
    this.dbx.db
      .insert(runEvents)
      .values({ runId, seq: this.nextSeq("run_events", "run_id", runId), type, payload, createdAt: Date.now() })
      .run();
  }

  /** Agent-runtime timeline events (tool_call / tool_result / error). */
  recordRunEvent(runId: string, type: RunEventType, payload: unknown): void {
    this.appendRunEvent(runId, type, payload);
  }

  bumpStatus(
    runId: string,
    status: "running" | "done" | "failed" | "cancelled" | "waiting_approval",
    extra?: { error?: string },
  ): void {
    const patch: Partial<typeof runs.$inferInsert> = { status };
    if (status === "running") patch.startedAt = Date.now();
    if (status === "done" || status === "failed" || status === "cancelled") patch.endedAt = Date.now();
    if (extra?.error !== undefined) patch.error = extra.error;
    this.dbx.db.update(runs).set(patch).where(eq(runs.id, runId)).run();
    this.appendRunEvent(runId, "status", { runId, status, ...(extra?.error ? { error: extra.error } : {}) });
  }

  /** Insert a run row; status = running. `agent` = tool-loop run (P2). */
  createRun(opts: { userId: string; conversationId?: string; model: string; trigger: "chat" | "schedule" | "webhook" | "manual" | "sandbox"; agent?: boolean }): string {
    const id = `run_${ulid()}`;
    this.dbx.db
      .insert(runs)
      .values({
        id,
        conversationId: opts.conversationId ?? null,
        userId: opts.userId,
        trigger: opts.trigger,
        status: "running",
        model: opts.model,
        budgets: { ...DEFAULT_BUDGETS },
        ...(opts.agent === true ? { agent: true as const } : {}),
        createdAt: Date.now(),
        startedAt: Date.now(),
      })
      .run();
    this.appendRunEvent(id, "status", { runId: id, status: "running" });
    return id;
  }

  /** run.get: read one run (materialized status row). */
  getRun(runId: string):
    | {
        id: string;
        userId: string;
        trigger: string;
        status: string;
        model: string;
        budgets: RunBudgets;
        createdAt: string;
        conversationId?: string;
        startedAt?: string;
        endedAt?: string;
        summary?: string;
        error?: string;
      }
    | undefined {
    const r = this.dbx.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!r) return undefined;
    return {
      id: r.id,
      userId: r.userId,
      trigger: r.trigger,
      status: r.status,
      model: r.model,
      budgets: r.budgets,
      createdAt: toIso(r.createdAt),
      ...(r.conversationId !== null ? { conversationId: r.conversationId } : {}),
      ...(r.startedAt !== null ? { startedAt: toIso(r.startedAt) } : {}),
      ...(r.endedAt !== null ? { endedAt: toIso(r.endedAt) } : {}),
      ...(r.summary !== null ? { summary: r.summary } : {}),
      ...(r.error !== null ? { error: r.error } : {}),
    };
  }

  /** run.events: ordered run_events since a seq (timeline replay). */
  runEvents(runId: string, since?: number): { seq: number; type: string; payload: unknown; createdAt: string }[] {
    return this.dbx.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .all()
      .sort((a, b) => a.seq - b.seq)
      .filter((e) => since === undefined || e.seq > since)
      .map((e) => ({ seq: e.seq, type: e.type, payload: e.payload, createdAt: toIso(e.createdAt) }));
  }

  private costEst(modelId: string, u: Usage): number {
    const row = this.dbx.db
      .select({ priceIn: models.priceIn, priceOut: models.priceOut })
      .from(models)
      .where(eq(models.id, modelId))
      .get();
    const cin = row?.priceIn ?? 0;
    const cout = row?.priceOut ?? 0;
    return (u.prompt_tokens / 1e6) * cin + (u.completion_tokens / 1e6) * cout;
  }

  private writeUsage(runId: string, modelId: string, providerId: string, u: Usage, latencyMs: number): number {
    const cost = this.costEst(modelId, u);
    this.dbx.db
      .insert(usage)
      .values({
        runId,
        provider: providerId,
        model: modelId,
        promptTokens: u.prompt_tokens,
        completionTokens: u.completion_tokens,
        costEst: cost,
        latencyMs,
        createdAt: Date.now(),
      })
      .run();
    return cost;
  }

  /** Redacted request envelope for raw_provider_request events (guardrail #4). */
  static redactedRequest(url: string, providerKind: string, headers: Record<string, string>, body: unknown): unknown {
    const redacted: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      redacted[k] = lk === "authorization" || lk === "x-api-key" ? "[REDACTED]" : v;
    }
    return { url, provider: providerKind, headers: redacted, body };
  }

  /**
   * ONE provider completion under a pre-created run — the shared inner step
   * for both the single-shot chat pipeline and the P2 agent loop. Stores the
   * redacted raw request/response (guardrail #4), streams deltas as
   * run_events + run.delta, writes the usage row + run.usage, and returns
   * the assembled assistant message. Does NOT touch run status, conversation
   * messages, or chat.* events — callers own those.
   */
  async stepCompletion(opts: {
    runId: string;
    wireModel: string;
    messages: Message[];
    tools?: ToolDefinition[];
    toolChoice?: ToolChoice;
    temperature?: number;
    maxTokens?: number;
    passthrough?: Record<string, unknown>;
    emit?: EmitFn;
    signal: AbortSignal;
    onChunk?: (chunk: ChatChunk) => void;
  }): Promise<{ message: Message & { reasoning_content?: string }; finishReason: string; usage: Usage }> {
    const emit: EmitFn = opts.emit ?? (() => {});
    const route = this.route(opts.wireModel);
    const chanRun = `run:${opts.runId}`;

    // The model profile wraps THIS request: its persona prepends the system
    // turn; its advanced params are the DEFAULTS (the caller's explicit
    // fields — passthrough/temperature/maxTokens — win).
    const profiledMessages = ChatService.withSystemPrompt(opts.messages, route.profile?.systemPrompt);

    const request: ChatCompletionRequest = {
      ...(route.profile?.params ?? {}),
      ...(opts.passthrough ?? {}),
      model: route.upstreamModel,
      messages: profiledMessages,
      stream: true,
      stream_options: { include_usage: true },
      ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
      ...(opts.toolChoice !== undefined ? { tool_choice: opts.toolChoice } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    };

    this.appendRunEvent(opts.runId, "raw_provider_request", ChatService.redactedRequest(`gateway→${route.provider.kind}`, route.provider.kind, { Authorization: "[REDACTED]" }, { ...request, model: route.upstreamModel }));

    const adapter = adapterFor(route.provider.kind);
    const startedAt = Date.now();
    const chunks: ChatChunk[] = [];
    try {
      for await (const chunk of adapter.chatStream(request, {
        apiKey: route.provider.apiKey,
        baseUrl: route.provider.baseUrl ?? "",
        signal: opts.signal,
        model: route.upstreamModel,
      })) {
        // Honor cancel/disconnect between chunks: adapters that stream
        // without honoring the signal themselves (scripted/lazy generators)
        // still halt here before the chunk lands anywhere.
        opts.signal.throwIfAborted();
        chunks.push(chunk);
        opts.onChunk?.(chunk);
        const d = chunk.choices[0]?.delta ?? {};
        const hasText = typeof d.content === "string" && d.content.length > 0;
        const hasReasoning = typeof d.reasoning_content === "string" && d.reasoning_content.length > 0;
        if (hasText || hasReasoning) {
          this.appendRunEvent(opts.runId, "delta", { text: hasText ? d.content : "", reasoning: hasReasoning ? d.reasoning_content : "" });
        }
        // Timeline deltas: run.delta carries text + reasoning. (chat.* deltas
        // belong to the conversation view — only runChat emits those.)
        if (hasText || hasReasoning) {
          emit("run.delta", chanRun, {
            ...(hasText ? { text: d.content } : {}),
            ...(hasReasoning ? { reasoning: d.reasoning_content } : {}),
          });
        }
        const firstTool = d.tool_calls?.[0];
        if (firstTool?.id !== undefined && firstTool.function?.name) {
          emit("run.tool_call", chanRun, { call: { id: firstTool.id, name: firstTool.function.name, args: JSON.parse(firstTool.function.arguments || "{}") } });
        }
      }

      const assembled = ChatService.assemble(chunks);
      const latencyMs = Date.now() - startedAt;
      const finalUsage: Usage =
        assembled.usage ?? estimateFromChars(opts.messages, assembled.message);
      this.appendRunEvent(opts.runId, "raw_provider_response", {
        provider: route.provider.kind,
        message: assembled.message,
        finishReason: assembled.finishReason,
        usage: finalUsage,
      });

      const cost = this.writeUsage(opts.runId, route.runModelId, route.provider.id, finalUsage, latencyMs);
      this.appendRunEvent(opts.runId, "usage", {
        promptTokens: finalUsage.prompt_tokens,
        completionTokens: finalUsage.completion_tokens,
        costEst: cost,
        latencyMs,
      });
      emit("run.usage", chanRun, {
        promptTokens: finalUsage.prompt_tokens,
        completionTokens: finalUsage.completion_tokens,
        costEst: cost,
        latencyMs,
      });

      return { message: assembled.message, finishReason: assembled.finishReason, usage: finalUsage };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new ProviderError(msg, 502);
    }
  }

  /**
   * The single-shot chat pipeline (REST + WS): pre-created or fresh run,
   * status lifecycle, chat.* conversation events, message persistence.
   * The provider step delegates to stepCompletion; v0 aborts = cancelled.
   */
  async runChat(opts: {
    userId: string;
    wireModel: string;
    messages: Message[];
    tools?: ToolDefinition[];
    toolChoice?: ToolChoice;
    temperature?: number;
    maxTokens?: number;
    /** Unknown client fields passed through to the provider untouched. */
    passthrough?: Record<string, unknown>;
    trigger: "chat" | "schedule" | "webhook" | "manual" | "sandbox";
    conversationId?: string;
    emit?: EmitFn;
    signal: AbortSignal;
    /** Per-chunk tap for true SSE streaming (REST plane). Called as chunks arrive. */
    onChunk?: (chunk: ChatChunk) => void;
    /** WS plane pre-allocates the run (so chat.send replies {runId} at once). */
    runId?: string;
  }): Promise<RunChatResult> {
    const emit: EmitFn = opts.emit ?? (() => {});
    const runId =
      opts.runId ??
      this.createRun({
        userId: opts.userId,
        conversationId: opts.conversationId,
        model: opts.wireModel,
        trigger: opts.trigger,
      });
    const chanRun = `run:${runId}`;
    emit("run.status", chanRun, { runId, status: "running" });

    // The conversation view needs chat.delta (WS chat plane): mirror the text
    // deltas that stepCompletion emits as run.delta.
    const convEmit: EmitFn =
      opts.conversationId !== undefined
        ? (event, channel, payload) => {
            if (event === "run.delta" && typeof payload === "object" && payload !== null) {
              const text = (payload as { text?: unknown }).text;
              if (typeof text === "string" && text.length > 0) {
                emit("chat.delta", `chat:${opts.conversationId}`, { delta: text });
              }
            }
            emit(event, channel, payload);
          }
        : emit;

    try {
      const step = await this.stepCompletion({
        runId,
        wireModel: opts.wireModel,
        messages: opts.messages,
        ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
        ...(opts.toolChoice !== undefined ? { tool_choice: opts.toolChoice } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.passthrough !== undefined ? { passthrough: opts.passthrough } : {}),
        emit: convEmit,
        signal: opts.signal,
        ...(opts.onChunk !== undefined ? { onChunk: opts.onChunk } : {}),
      });

      const finalUsage = step.usage;

      if (opts.conversationId !== undefined) {
        const id = `msg_${ulid()}`;
        const seq = this.nextSeq("messages", "conversation_id", opts.conversationId);
        this.dbx.db
          .insert(messages)
          .values({ id, conversationId: opts.conversationId, runId, seq, role: "assistant", content: step.message as Message, createdAt: Date.now() })
          .run();
        this.dbx.db.update(conversations).set({ updatedAt: Date.now() }).where(eq(conversations.id, opts.conversationId)).run();
        emit("chat.final", `chat:${opts.conversationId}`, { message: step.message });
      }

      this.bumpStatus(runId, "done");
      emit("run.status", chanRun, { runId, status: "done" });
      return { runId, message: step.message, usage: finalUsage, finishReason: step.finishReason };
    } catch (err) {
      // v0 aborts = cancelled (P2 formalizes run.cancel semantics).
      const cancelled = opts.signal.aborted;
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.bumpStatus(runId, cancelled ? "cancelled" : "failed", cancelled ? undefined : { error: msg });
      emit("run.status", chanRun, cancelled ? { runId, status: "cancelled" } : { runId, status: "failed", error: msg });
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(msg, 502);
    }
  }

  // -- conversations / messages --------------------------------------------

  appendMessage(conversationId: string, message: Message, runId?: string): { id: string; seq: number } {
    const id = `msg_${ulid()}`;
    const seq = this.nextSeq("messages", "conversation_id", conversationId);
    this.dbx.db
      .insert(messages)
      .values({ id, conversationId, runId: runId ?? null, seq, role: message.role, content: message, createdAt: Date.now() })
      .run();
    this.dbx.db.update(conversations).set({ updatedAt: Date.now() }).where(eq(conversations.id, conversationId)).run();
    return { id, seq };
  }

  history(conversationId: string, before?: number, limit = 200): (Message & { id: string; seq: number; createdAt: string })[] {
    const all = this.dbx.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .all()
      .sort((a, b) => a.seq - b.seq);
    const windowRows = all.filter((m) => (before === undefined || m.seq < before));
    return windowRows.slice(-limit).map((r) => ({
      ...(r.content as Message),
      id: r.id,
      seq: r.seq,
      createdAt: toIso(r.createdAt),
    }));
  }

  createConversation(userId: string, title?: string, model?: string) {
    const id = `ch_${ulid()}`;
    const now = Date.now();
    const finalTitle = title?.trim() || "New chat";
    this.dbx.db
      .insert(conversations)
      .values({ id, userId, title: finalTitle, model: model ?? null, createdAt: now, updatedAt: now, meta: null })
      .run();
    return { id, title: finalTitle, model, createdAt: toIso(now), updatedAt: toIso(now) };
  }

  /**
   * Where execution is bound for this chat (ADR-015): `{location, envId?}` in
   * conversations.meta. Set by chat.send when the composer picks a location
   * and maintained by the agent runtime (binding to the resolved env).
   */
  setConversationBinding(conversationId: string, binding: { location: "local" | "cloud"; envId?: string }): void {
    const row = this.dbx.db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
    if (row === undefined) throw new Error(`unknown conversation: ${conversationId}`);
    const meta = { ...(row.meta ?? {}) };
    meta["location"] = binding.location;
    if (binding.envId === undefined) delete meta["envId"];
    else meta["envId"] = binding.envId;
    this.dbx.db.update(conversations).set({ meta }).where(eq(conversations.id, conversationId)).run();
  }

  getConversationBinding(conversationId: string): { location: "local" | "cloud"; envId?: string } | undefined {
    const row = this.dbx.db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
    if (row === undefined) return undefined;
    const meta = row.meta ?? {};
    const location = meta["location"];
    if (location !== "local" && location !== "cloud") return undefined;
    const envId = typeof meta["envId"] === "string" ? meta["envId"] : undefined;
    return { location, ...(envId !== undefined ? { envId } : {}) };
  }

  /** True while a run of this conversation is not in a terminal status. */
  hasActiveRun(conversationId: string): boolean {
    const rows = this.dbx.db
      .select({ status: runs.status })
      .from(runs)
      .where(and(eq(runs.conversationId, conversationId), inArray(runs.status, ["running", "waiting_approval"] as RunStatusValue[])))
      .all();
    return rows.length > 0;
  }

  /** P5 concurrent-run quota: the user's non-terminal runs (queued included). */
  activeRunCount(userId: string): number {
    const rows = this.dbx.db
      .select({ status: runs.status })
      .from(runs)
      .where(and(eq(runs.userId, userId), inArray(runs.status, ["queued", "running", "waiting_approval"] as RunStatusValue[])))
      .all();
    return rows.length;
  }

  listConversations(userId: string) {
    return this.dbx.db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, userId))
      .all()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => {
        const meta = c.meta ?? {};
        const location = meta["location"];
        const envId = typeof meta["envId"] === "string" ? meta["envId"] : undefined;
        return {
          id: c.id,
          title: c.title,
          model: c.model ?? undefined,
          ...(location === "local" || location === "cloud" ? { location } : {}),
          ...(envId !== undefined ? { envId } : {}),
          createdAt: toIso(c.createdAt),
          updatedAt: toIso(c.updatedAt),
        };
      });
  }
}

function estimateFromChars(input: Message[], message: Message): Usage {
  const charsIn = input.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 64), 0);
  const charsOut = typeof message.content === "string" ? message.content.length : 64;
  const p = Math.max(1, Math.ceil(charsIn / 4));
  const c = Math.max(1, Math.ceil(charsOut / 4));
  return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
}