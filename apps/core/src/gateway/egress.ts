import type { FastifyInstance, FastifyRequest } from "fastify";
import { Value } from "@sinclair/typebox/value";
import { MessageSchema } from "@foundry/protocol";
import type { Message } from "@foundry/protocol";
import type { ChatService, EmitFn } from "./chat.js";
import type { SandboxService } from "../sandbox/service.js";
import type { ProviderStore } from "../providers/store.js";
import type { ToolChoice, ToolDefinition } from "../providers/types.js";
import { ProviderError } from "../providers/types.js";
import type { ChatChunk } from "../providers/types.js";

/**
 * The egress plane (ADR-005, build-order P2 #2): the OpenAI-compatible surface
 * sandbox containers reach with a scoped `esc_` token instead of a real key.
 * Token verified → one ChatService.stepCompletion, so every sandbox LLM call
 * is metered (usage ledger), journaled raw + redacted (guardrails #2/#4), and
 * streams back with exact OpenAI chunk semantics. The token grants only "make
 * LLM calls through the gateway" — listing models + chat completions.
 *
 * Run attribution: a fresh `trigger: "sandbox"` run per unlinked call; the
 * caller may pass `X-Foundry-Run-Id` to journal traffic under the run that
 * spawned the sandbox (accepted only when that run is live and owned by the
 * token's user — a token can never write into someone else's run).
 */

export interface EgressDeps {
  sandbox: SandboxService;
  chat: ChatService;
  providers: ProviderStore;
  /** Event sink for timeline streaming (hub.publish — run.delta etc.). */
  emit: EmitFn;
}

interface EgressAuth {
  userId: string;
  envId: string;
  workspaceId: string | null;
}

/* OpenAI-shaped error body (same envelope as the REST plane). */
function egressError(status: number, message: string): { error: { message: string; type: string; param: null } } {
  const type = status === 400 ? "invalid_request_error"
    : status === 401 ? "authentication_error"
    : status === 404 ? "not_found_error"
    : "api_error";
  return { error: { message, type, param: null } };
}

/** Accept `content: null` (OpenAI tool-call turns) by normalizing to "". */
function normalizeMessage(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const m = { ...(raw as Record<string, unknown>) };
  if (m["content"] === null) m["content"] = "";
  return m;
}

export function registerEgress(app: FastifyInstance, deps: EgressDeps): void {
  const authenticate = (request: FastifyRequest): EgressAuth | undefined => {
    const header = request.headers.authorization ?? "";
    const match = /^Bearer (esc_[0-9a-f]{32,128})$/.exec(header);
    const token = match?.[1];
    if (token === undefined) return undefined;
    const info = deps.sandbox.verifyEgressToken(token);
    if (info === undefined) return undefined;
    if (info.userId === undefined) return undefined; // never (workspace join), satisfies strict types
    deps.sandbox.markActive(info.envId);
    return info;
  };

  app.get("/v1/egress/models", async (request, reply) => {
    const info = authenticate(request);
    if (info === undefined) {
      await reply.code(401).send(egressError(401, "invalid egress token"));
      return;
    }
    return {
      object: "list" as const,
      data: deps.providers.listModels().filter((m) => m.enabled).map((m) => ({
        id: m.id,
        object: "model" as const,
        created: 1_700_000_000,
        owned_by: m.providerId,
      })),
    };
  });

  app.post("/v1/egress/chat/completions", async (request, reply) => {
    const info = authenticate(request);
    if (info === undefined) {
      await reply.code(401).send(egressError(401, "invalid egress token"));
      return;
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const wireModel = typeof body["model"] === "string" ? body["model"] : undefined;
    const rawMessages = body["messages"];
    if (wireModel === undefined || !Array.isArray(rawMessages)) {
      await reply.code(400).send(egressError(400, "`model` and `messages` are required"));
      return;
    }

    const messages: Message[] = [];
    for (let i = 0; i < rawMessages.length; i++) {
      const m = normalizeMessage(rawMessages[i]);
      if (!Value.Check(MessageSchema, m)) {
        await reply.code(400).send(egressError(400, `messages[${i}] is not a valid OpenAI message`));
        return;
      }
      messages.push(m);
    }
    if (messages.length === 0) {
      await reply.code(400).send(egressError(400, "messages must not be empty"));
      return;
    }

    const tools = Array.isArray(body["tools"]) ? (body["tools"] as ToolDefinition[]) : undefined;
    const toolChoice = body["tool_choice"] !== undefined ? (body["tool_choice"] as ToolChoice) : undefined;
    const temperature = typeof body["temperature"] === "number" ? body["temperature"] : undefined;
    const maxTokens = typeof body["max_tokens"] === "number" ? body["max_tokens"] : undefined;
    const stream = body["stream"] === true;
    const includeUsage = (body["stream_options"] as { include_usage?: boolean } | undefined)?.include_usage === true;

    // Unknown fields pass through to the provider untouched.
    const KNOWN = new Set(["model", "messages", "stream", "stream_options", "tools", "tool_choice", "temperature", "max_tokens"]);
    const passthrough: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (!KNOWN.has(k)) passthrough[k] = v;
    }

    // Link to the spawning run when the header is present and trustworthy.
    // A linked run stays owned by its loop: we journal into it but never
    // touch its status (a sandboxed sub-call must not terminate an agent run).
    const headerRunId = request.headers["x-foundry-run-id"];
    const headerStr = typeof headerRunId === "string" ? headerRunId : Array.isArray(headerRunId) ? headerRunId[0] : undefined;
    const linked = headerStr !== undefined ? deps.chat.getRun(headerStr) : undefined;
    const linkedUsable = linked !== undefined && linked.userId === info.userId && linked.status === "running";
    const runId = linkedUsable
      ? linked.id
      : deps.chat.createRun({
          userId: info.userId,
          model: wireModel,
          trigger: "sandbox",
        });

    const chanRun = `run:${runId}`;
    const emit: EmitFn = deps.emit;

    // Abort the provider stream when the client disconnects mid-flight.
    // NOTE: IncomingMessage 'close' fires once the request body is fully
    // consumed (normal keep-alive requests!) — the SOCKET closing is what
    // actually means the client went away.
    const controller = new AbortController();
    request.raw.socket.on("close", () => controller.abort());

    try {
      if (!stream) {
        const result = await deps.chat.stepCompletion({
          runId,
          wireModel,
          messages,
          ...(tools !== undefined ? { tools } : {}),
          ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
          passthrough,
          emit,
          signal: controller.signal,
        });
        if (!linkedUsable) {
          deps.chat.bumpStatus(runId, "done");
          emit("run.status", chanRun, { runId, status: "done" });
        }
        return {
          id: `chatcmpl-foundry-${runId}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: wireModel,
          choices: [{ index: 0, message: result.message, finish_reason: result.finishReason }],
          usage: result.usage,
        };
      }

      // SSE: hijack the reply, write provider chunks as they arrive.
      await reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const writeSse = (data: string): void => {
        raw.write(`data: ${data}\n\n`);
      };
      let sawUsageChunk = false;
      try {
        const result = await deps.chat.stepCompletion({
          runId,
          wireModel,
          messages,
          ...(tools !== undefined ? { tools } : {}),
          ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
          passthrough,
          emit,
          signal: controller.signal,
          onChunk: (chunk: ChatChunk) => {
            // Upstream always gets include_usage forced (metering); only hand
            // a usage-only chunk to the caller when it asked for it.
            const usageOnly = (chunk.choices === undefined || chunk.choices.length === 0) && chunk.usage !== undefined;
            if (usageOnly && !includeUsage) return;
            if (usageOnly) sawUsageChunk = true;
            writeSse(JSON.stringify({ ...chunk, model: wireModel }));
          },
        });
        if (includeUsage && !sawUsageChunk) {
          writeSse(JSON.stringify({
            id: "chatcmpl-foundry-usage",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: wireModel,
            choices: [],
            usage: result.usage,
          }));
        }
        writeSse("[DONE]");
        raw.end();
        if (!linkedUsable) {
          deps.chat.bumpStatus(runId, "done");
          emit("run.status", chanRun, { runId, status: "done" });
        }
      } catch (err) {
        // Linked runs stay owned by their loop — only journal, never mutate.
        if (!linkedUsable) {
          if (controller.signal.aborted) {
            deps.chat.bumpStatus(runId, "cancelled");
            emit("run.status", chanRun, { runId, status: "cancelled" });
          } else {
            deps.chat.bumpStatus(runId, "failed", { error: err instanceof Error ? err.message : String(err) });
            emit("run.status", chanRun, { runId, status: "failed" });
          }
        }
        // Mid-stream failure: announce, then close (headers already gone).
        if (raw.writableEnded) return reply;
        const payload = err instanceof ProviderError
          ? { code: err.status >= 500 ? "provider_error" : "bad_request", message: err.message, retryable: err.retryable }
          : { code: "internal", message: err instanceof Error ? err.message : String(err) };
        writeSse(JSON.stringify({ error: payload }));
        raw.end();
      }
      return reply;
    } catch (err) {
      // Pre-stream failure (routing/validation/provider refused).
      // Linked runs stay owned by their loop — only journal, never mutate.
      if (!linkedUsable) {
        deps.chat.bumpStatus(runId, "failed", { error: err instanceof Error ? err.message : String(err) });
        emit("run.status", chanRun, { runId, status: "failed" });
      }
      if (reply.raw.headersSent) {
        reply.raw.end();
        return reply;
      }
      if (err instanceof ProviderError) {
        await reply.code(err.status).send(egressError(err.status, err.message));
        return;
      }
      await reply.code(500).send(egressError(500, err instanceof Error ? err.message : String(err)));
    }
  });
}