import type { FastifyInstance, FastifyRequest } from "fastify";
import { PassThrough } from "node:stream";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Value } from "@sinclair/typebox/value";
import {
  HookCreateParamsSchema,
  HookPayloadSchema,
  ScheduleCreateParamsSchema,
  SchedulePatchParamsSchema,
  MessageSchema,
} from "@foundry/protocol";
import type { HookCreateParams, HookPayload, ScheduleCreateParams, SchedulePatchParams, Message } from "@foundry/protocol";
import type { AuthService, IssuedKey } from "../auth/auth.js";
import type { ChatService } from "./chat.js";
import type { ProviderStore } from "../providers/store.js";
import type { ToolChoice, ToolDefinition } from "../providers/types.js";
import { ProviderError } from "../providers/types.js";
import type { ChatChunk, Usage } from "../providers/types.js";
import type { McpManager } from "../agent/mcp.js";
import type { PushService } from "../executor/push.js";
import { McpServerSchema, type McpServer } from "../agent/mcp.js";
import type { SchedulerService } from "../agent/schedules.js";
import type { HookService } from "./hooks.js";
import type { AuditService } from "../audit/audit.js";
import type { BackupService } from "../backup/backup.js";
import type { RateLimiter } from "./limits.js";
import { isSpaPath } from "./web.js";

/**
 * REST plane (protocol.md §2): OpenAI-compatible /v1 + auth + admin. Bearer
 * key auth everywhere (open: /healthz, /readyz, /v1/auth/login). Streaming =
 * true SSE passthrough of provider chunks with exact OpenAI chunk semantics +
 * `[DONE]`. Unknown request fields pass through to providers untouched.
 */

interface AuthedRequest extends FastifyRequest {
  user?: { userId: string };
  /** Raw request bytes, tee'd in preParsing (webhook HMAC plane only). */
  rawBody?: Buffer;
}

/* OpenAI-shaped error body; `type` is derived from the status per their taxonomy
 * (invalid_request_error | authentication_error | not_found_error | api_error)
 * rather than the caller's hint. */
function openAiError(status: number, message: string, _type: string): { error: { message: string; type: string; param: null } } {
  const code = status === 400 ? "invalid_request_error"
    : status === 401 ? "authentication_error"
    : status === 404 ? "not_found_error"
    : status === 500 ? "api_error"
    : "api_error";
  return { error: { message, type: code, param: null } };
}

export interface RestDeps {
  chat: ChatService;
  providers: ProviderStore;
  auth: AuthService;
  version: string;
  /** Event router (hub.publish) — REST runs broadcast to WS clients too. */
  emit?: (event: string, channel: string, payload: unknown) => void;
  /** MCP client manager (P2 admin endpoints; undefined → endpoints report down). */
  mcp?: McpManager;
  /** Fired when the admin PUT replaces the MCP server list. */
  onMcpServersChanged?: () => void;
  /** Schedule triggers (P3 admin plane; undefined → endpoints report down). */
  schedules?: SchedulerService;
  /** Webhook triggers (P3 trigger + admin plane; undefined → endpoints report down). */
  hooks?: HookService;
  /** ADR-015 push-to-cloud (undefined → the route reports down). */
  push?: PushService;
  /** P5 audit + limits + backups (optional — unit tests may omit). */
  audit?: AuditService;
  /** REST-plane rate limit per authed identity (chat/completions + models). */
  apiLimiter?: RateLimiter;
  backup?: BackupService;
}

export function registerRest(app: FastifyInstance, deps: RestDeps): void {
  // Auth gate. WS (/ws) authenticates inside the connect frame instead.
  app.addHook("onRequest", async (request, reply) => {
    const path = request.routeOptions.url ?? request.url.split("?")[0] ?? "";
    // P4: when the SPA is served, its files (and unmatched deep links) are
    // public by design — the shell carries no secrets; login must work.
    if (isSpaPath(app, request.method, request.url.split("?")[0] ?? "/")) return;
    if (path === "/healthz" || path === "/readyz" || path === "/v1/auth/login" || path === "/ws" || path === "/term") return;
    // Egress plane self-authenticates with scoped sandbox tokens (ADR-005, not user keys).
    if (path.startsWith("/v1/egress/") || path === "/v1/egress") return;
    // Webhook trigger plane (P3): HMAC-signed with a dedicated secret — no
    // bearer key, on purpose (give one to a cron service without a Foundry key).
    if (path.startsWith("/hook/")) return;
    const header = request.headers.authorization ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    const token = match?.[1];
    const user = token === undefined ? undefined : deps.auth.verifyToken(token);
    if (!user) {
      await reply.code(401).send(openAiError(401, "missing or invalid Authorization: Bearer <key>", "authentication_error"));
      return;
    }
    (request as AuthedRequest).user = user;
  });

  // Webhook HMAC covers the RAW body, so tee request bytes before Fastify's
  // body parser consumes the stream (preParsing). JSON parsing still works —
  // the tee feeds a PassThrough back to Fastify.
  app.addHook("preParsing", (request, _reply, payload, done) => {
    const path = request.routeOptions.url ?? request.url.split("?")[0] ?? "";
    if (!path.startsWith("/hook/")) {
      done(null, payload);
      return;
    }
    const chunks: Buffer[] = [];
    const tee = new PassThrough();
    payload.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      tee.write(chunk);
    });
    payload.on("end", () => {
      (request as AuthedRequest).rawBody = Buffer.concat(chunks);
      tee.end();
      done(null, tee);
    });
    payload.on("error", (err) => {
      done(err instanceof Error ? err : new Error(String(err)), payload);
      return;
    });
  });

  // -- auth ------------------------------------------------------------------

  /** P2 test page for term.* — plain html, not part of the wire contract. */
  app.get("/term", async (_request, reply) => {
    const html = await readFile(fileURLToPath(new URL("./term_page.html", import.meta.url)), "utf8");
    await reply.type("text/html; charset=utf-8").send(html);
  });

  app.post("/v1/auth/login", async (request, reply) => {
    const body = (request.body ?? {}) as { username?: string; password?: string };
    if (typeof body.username !== "string" || body.username.length === 0 || typeof body.password !== "string" || body.password.length === 0) {
      await reply.code(400).send(openAiError(400, "username and password are required", "invalid_request_error"));
      return;
    }
    // scrypt verification is deliberately slow (~50-100 ms) — awaits inside.
    const session = await deps.auth.loginWithPassword(body.username, body.password);
    if (!session) {
      await reply.code(401).send(openAiError(401, "invalid username or password", "authentication_error"));
      return;
    }
    return { sessionToken: session.plaintext, expiresAt: new Date(session.expiresAt).toISOString() };
  });

  // ADR-006: self-service password change for the authenticated user.
  app.post("/v1/auth/password", async (request, reply) => {
    const user = (request as AuthedRequest).user;
    if (!user) return; // unreachable (auth hook), satisfies strict types
    const body = (request.body ?? {}) as { currentPassword?: string; newPassword?: string };
    if (typeof body.newPassword !== "string" || body.newPassword.length < 8 || body.newPassword.length > 128) {
      await reply.code(400).send(openAiError(400, "newPassword must be 8-128 characters", "invalid_request_error"));
      return;
    }
    if (body.currentPassword !== undefined && typeof body.currentPassword !== "string") {
      await reply.code(400).send(openAiError(400, "currentPassword must be a string", "invalid_request_error"));
      return;
    }
    const ok = await deps.auth.setPassword(user.userId, body.currentPassword, body.newPassword);
    if (!ok) {
      await reply.code(401).send(openAiError(401, "current password incorrect", "authentication_error"));
      return;
    }
    return { ok: true };
  });

  // ADR-015: push a chat's local workspace + deps into a backend (cloud) env.
  app.post("/v1/chats/:chatId/push", async (request, reply) => {
    const user = (request as AuthedRequest).user;
    if (!user) return; // unreachable (auth hook), satisfies strict types
    if (deps.push === undefined) {
      await reply.code(501).send(openAiError(501, "push-to-cloud unavailable", "api_error"));
      return;
    }
    const { chatId } = request.params as { chatId: string };
    try {
      return await deps.push.pushChatToCloud(user.userId, chatId);
    } catch (err) {
      // PushRejected and SandboxError both carry an HTTP-ish status — map any
      // status-carrying rejection (500 with no status is the generic catch).
      const status = (err as { status?: unknown }).status;
      if (typeof status === "number" && status >= 400 && status < 505) {
        const type = status === 409 || status === 400 || status === 404
          ? "invalid_request_error"
          : status === 503 || status === 504
            ? "capacity"
            : "api_error";
        await reply.code(status).send(openAiError(status, err instanceof Error ? err.message : "push failed", type));
        return;
      }
      await reply.code(500).send(openAiError(500, err instanceof Error ? err.message : "push failed", "api_error"));
    }
  });

  // -- openai-compatible -----------------------------------------------------

  app.get("/v1/models", async () => {
    return {
      object: "list" as const,
      data: deps.providers.listModels().filter((m) => m.enabled).map((m) => ({
        id: m.id,
        object: "model" as const,
        created: 1_700_000_000,
        owned_by: m.providerId,
        name: m.name,
        context: m.context,
        caps: m.caps,
        ...(m.priceIn !== null ? { price_in_per_mtok: m.priceIn } : {}),
        ...(m.priceOut !== null ? { price_out_per_mtok: m.priceOut } : {}),
      })),
    };
  });

  app.post("/v1/chat/completions", async (request, reply) => {
    const user = (request as AuthedRequest).user;
    if (!user) return; // unreachable (auth hook), satisfies strict types
    // P5: per-identity rate limit before any provider work.
    if (deps.apiLimiter !== undefined && !deps.apiLimiter.take(user.userId)) {
      await reply.code(429).send(openAiError(429, "rate limit exceeded", "api_error"));
      return;
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const wireModel = typeof body["model"] === "string" ? body["model"] : undefined;
    const rawMessages = body["messages"];
    if (wireModel === undefined || !Array.isArray(rawMessages)) {
      await reply.code(400).send(openAiError(400, "`model` and `messages` are required", "invalid_request_error"));
      return;
    }

    // Canonical validation at the edge; normalize content:null → "" (OpenAI
    // sends it for assistant tool_call turns).
    const messages: Message[] = [];
    for (let i = 0; i < rawMessages.length; i++) {
      const m = normalizeMessage(rawMessages[i]);
      if (!Value.Check(MessageSchema, m)) {
        await reply.code(400).send(openAiError(400, `messages[${i}] is not a valid OpenAI message`, "invalid_request_error"));
        return;
      }
      messages.push(m);
    }
    if (messages.length === 0) {
      await reply.code(400).send(openAiError(400, "messages must not be empty", "invalid_request_error"));
      return;
    }

    const stream = body["stream"] === true;
    const includeUsage =
      (body["stream_options"] as { include_usage?: boolean } | undefined)?.include_usage === true;
    const tools = Array.isArray(body["tools"]) ? (body["tools"] as ToolDefinition[]) : undefined;
    const toolChoice = body["tool_choice"] !== undefined ? (body["tool_choice"] as ToolChoice) : undefined;
    const temperature = typeof body["temperature"] === "number" ? body["temperature"] : undefined;
    const maxTokens = typeof body["max_tokens"] === "number" ? body["max_tokens"] : undefined;

    // Unknown fields pass through untouched (protocol.md §2).
    const KNOWN = new Set(["model", "messages", "stream", "stream_options", "tools", "tool_choice", "temperature", "max_tokens"]);
    const passthrough: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (!KNOWN.has(k)) passthrough[k] = v;
    }

    // Abort the provider stream when the client disconnects mid-flight.
    // NOTE: IncomingMessage 'close' fires once the request body is fully
    // consumed (normal keep-alive requests!) — the SOCKET closing is what
    // actually means the client went away.
    const controller = new AbortController();
    request.raw.socket.on("close", () => controller.abort());

    try {
      if (!stream) {
        const result = await deps.chat.runChat({
          userId: user.userId,
          wireModel,
          messages,
          ...(tools !== undefined ? { tools } : {}),
          ...(toolChoice !== undefined ? { toolChoice } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          passthrough,
          trigger: "manual",
          signal: controller.signal,
          emit: deps.emit,
        });
        return toOpenAiResponse(wireModel, result);
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
        const result = await deps.chat.runChat({
          userId: user.userId,
          wireModel,
          messages,
          ...(tools !== undefined ? { tools } : {}),
          ...(toolChoice !== undefined ? { toolChoice } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          passthrough,
          trigger: "manual",
          signal: controller.signal,
          emit: deps.emit,
          onChunk: (chunk: ChatChunk) => {
            // Upstream always gets include_usage forced (metering); only hand
            // a usage-only chunk to the client when it asked for it.
            const usageOnly = (chunk.choices === undefined || chunk.choices.length === 0) && chunk.usage !== undefined;
            if (usageOnly && !includeUsage) return;
            if (usageOnly) sawUsageChunk = true;
            writeSse(JSON.stringify({ ...chunk, model: wireModel }));
          },
        });
        if (includeUsage && !sawUsageChunk) {
          writeSse(JSON.stringify(usageOnlyChunk(wireModel, result.usage)));
        }
        writeSse("[DONE]");
        raw.end();
      } catch (err) {
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
      if (reply.raw.headersSent) {
        reply.raw.end();
        return reply;
      }
      if (err instanceof ProviderError) {
        await reply.code(err.status).send(openAiError(err.status, err.message, err.status >= 500 ? "api_error" : "invalid_request_error"));
        return;
      }
      await reply.code(500).send(openAiError(500, err instanceof Error ? err.message : String(err), "api_error"));
    }
  });

  // -- admin: providers + models ----------------------------------------------

  app.post("/v1/admin/providers", async (request, reply) => {
    const body = (request.body ?? {}) as {
      id?: string;
      kind?: string;
      baseUrl?: string;
      apiKey?: string;
      models?: { id?: string; name?: string; context?: number; caps?: { vision?: boolean; tools?: boolean; reasoning?: boolean; json?: boolean }; priceIn?: number; priceOut?: number }[];
    };
    const kind = body.kind;
    if (kind !== "openai_compat" && kind !== "anthropic" && kind !== "dummy") {
      await reply.code(400).send(openAiError(400, "kind must be one of openai_compat | anthropic | dummy", "invalid_request_error"));
      return;
    }
    if ((kind === "openai_compat" || kind === "anthropic") && (typeof body.baseUrl !== "string" || body.baseUrl.length === 0)) {
      await reply.code(400).send(openAiError(400, "baseUrl required for network providers", "invalid_request_error"));
      return;
    }
    // True upsert: an explicit id creates-or-patches (idempotent operator
    // config — `POST ... {id: "ollama"}` twice never duplicates), a missing
    // id generates one.
    const { id: providerId, created } = deps.providers.upsert({
      kind,
      ...(typeof body.id === "string" && body.id.length > 0 ? { id: body.id } : {}),
      ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
      ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
    });

    const effectiveIds: string[] = [];
    let pulled: boolean | undefined;
    let pullError: string | undefined;
    if (Array.isArray(body.models) && body.models.length > 0) {
      const upserts = body.models.map((m) => {
        const fullId = typeof m.id === "string" && m.id.length > 0
          ? (m.id.includes("/") ? m.id : `${providerId}/${m.id}`)
          : undefined;
        if (fullId === undefined) return undefined;
        effectiveIds.push(fullId);
        return {
          id: fullId,
          name: typeof m.name === "string" && m.name.length > 0 ? m.name : fullId,
          context: typeof m.context === "number" && m.context > 0 ? m.context : 8192,
          caps: {
            vision: m.caps?.vision === true,
            tools: m.caps?.tools === true,
            reasoning: m.caps?.reasoning === true,
            json: m.caps?.json === true,
          },
          ...(m.priceIn !== undefined ? { priceIn: m.priceIn } : {}),
          ...(m.priceOut !== undefined ? { priceOut: m.priceOut } : {}),
        };
      }).filter((m): m is NonNullable<typeof m> => m !== undefined);
      // Explicit list wins AND replaces (drops models gone upstream).
      deps.providers.replaceModels(providerId, upserts);
    } else if (kind === "openai_compat") {
      // Models omitted → pull the provider's OpenAI-compatible /models
      // (Ollama/LM Studio/vLLM/OpenRouter all serve it) and adopt the list.
      // A failed pull does NOT fail the upsert — the provider is saved and
      // `pullError` tells the operator what to look at.
      const base = (
        body.baseUrl ?? deps.providers.record(providerId, { withKey: false })?.baseUrl ?? ""
      ).replace(/\/+$/, "");
      if (base.length > 0) {
        const key = deps.providers.record(providerId, { withKey: true })?.apiKey;
        try {
          const res = await fetch(`${base}/models`, {
            headers: { ...(key !== undefined ? { Authorization: `Bearer ${key}` } : {}) },
            signal: AbortSignal.timeout(4_000), // a slow provider must not hang the admin op
          });
          if (res.ok) {
            const list = (await res.json()) as { data?: { id?: unknown }[] };
            const discovered = (Array.isArray(list.data) ? list.data : [])
              .filter((m): m is { id: string } => typeof m["id"] === "string" && (m["id"] as string).length > 0)
              .map((m) => ({
                id: m.id.includes("/") ? m.id : `${providerId}/${m.id}`,
                name: m.id,
                context: 8192,
                // Discovered models default tool-capable; correct per model
                // in the admin list if one misbehaves with tools.
                caps: { vision: false, tools: true, reasoning: false, json: false },
              }));
            effectiveIds.push(...discovered.map((m) => m.id));
            deps.providers.replaceModels(providerId, discovered);
            pulled = true;
          } else {
            pullError = `${base}/models → ${res.status}`;
          }
        } catch (err) {
          pullError = err instanceof Error ? err.message : String(err);
        }
      }
    }
    // reply.code is NOT awaited: the reply is a thenable that resolves only
    // when the response is sent — awaiting it here (without .send) deadlocks
    // the handler forever. Set the status, then return the body to be sent.
    reply.code(created ? 201 : 200);
    deps.audit?.record({
      action: "admin.providers.upsert",
      target: providerId,
      meta: { created, models: effectiveIds, hasNewKey: body.apiKey !== undefined, ...(pulled !== undefined ? { pulled } : {}) },
    });
    return {
      id: providerId,
      models: effectiveIds,
      ...(pulled !== undefined ? { pulled } : {}),
      ...(pullError !== undefined ? { pullError } : {}),
    };
  });

  app.get("/v1/admin/providers", async () => {
    return {
      providers: deps.providers.list().map((p) => ({
        id: p.id,
        kind: p.kind,
        baseUrl: p.baseUrl ?? null,
        enabled: p.enabled,
        // Never echo keys — boolean only (hard guardrail #2).
        hasKey: p.vaultKeyId !== null,
      })),
    };
  });

  app.delete("/v1/admin/providers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const ok = deps.providers.remove(id);
    if (!ok) {
      await reply.code(404).send(openAiError(404, `unknown provider: ${id}`, "invalid_request_error"));
      return;
    }
    deps.audit?.record({ action: "admin.providers.delete", target: id });
    return { ok: true };
  });

  // -- admin: API keys ---------------------------------------------------------

  app.post("/v1/admin/keys", async (request) => {
    const user = (request as AuthedRequest).user;
    if (!user) return;
    const body = (request.body ?? {}) as { name?: string };
    const issued: IssuedKey = deps.auth.mintKey(user.userId, typeof body.name === "string" && body.name.trim().length > 0 ? body.name.trim() : "unnamed");
    deps.audit?.record({ action: "admin.keys.create", target: issued.id, meta: { name: issued.name } });
    // Plaintext appears exactly once — never stored, never echoed again.
    return { id: issued.id, name: issued.name, key: issued.plaintext };
  });

  app.get("/v1/admin/keys", async (request) => {
    const user = (request as AuthedRequest).user;
    if (!user) return { keys: [] };
    return { keys: deps.auth.listKeys(user.userId) };
  });

  app.delete("/v1/admin/keys/:id", async (request, reply) => {
    const user = (request as AuthedRequest).user;
    if (!user) return;
    const { id } = request.params as { id: string };
    const ok = deps.auth.revokeKey(user.userId, id);
    if (!ok) {
      await reply.code(404).send(openAiError(404, `unknown or already-revoked key: ${id}`, "invalid_request_error"));
      return;
    }
    deps.audit?.record({ userId: user.userId, action: "admin.keys.delete", target: id });
    return { ok: true };
  });

  // -- admin: MCP servers (P2, build-order task 6) ------------------------------

  app.get("/v1/admin/mcp/servers", async () => {
    return { status: deps.mcp?.status() ?? [] };
  });

  app.put("/v1/admin/mcp/servers", async (request, reply) => {
    const body = (request.body ?? {}) as { servers?: unknown };
    if (!deps.mcp) {
      await reply.code(503).send(openAiError(503, "mcp manager unavailable", "api_error"));
      return;
    }
    const servers = body.servers;
    if (!Array.isArray(servers)) {
      await reply.code(400).send(openAiError(400, "`servers` must be an array", "invalid_request_error"));
      return;
    }
    const valid: McpServer[] = [];
    for (let i = 0; i < servers.length; i++) {
      const s = servers[i];
      if (!Value.Check(McpServerSchema, s)) {
        await reply.code(400).send(openAiError(400, `servers[${i}] violates the MCP server schema`, "invalid_request_error"));
        return;
      }
      valid.push(s);
    }
    if (new Set(valid.map((s) => s.name)).size !== valid.length) {
      await reply.code(400).send(openAiError(400, "server names must be unique", "invalid_request_error"));
      return;
    }
    deps.mcp.setServers(valid);
    deps.audit?.record({ action: "admin.mcp.replace", meta: { count: valid.length, names: valid.map((s) => s.name) } });
    deps.onMcpServersChanged?.();
    // Reconnect synchronously so the response reflects the new state.
    void deps.mcp.reload();
    return { ok: true, count: valid.length };
  });

  // -- webhook trigger plane (P3, public + HMAC) --------------------------------

  app.post("/hook/:id", async (request, reply) => {
    if (!deps.hooks) {
      await reply.code(503).send(openAiError(503, "hooks service unavailable", "api_error"));
      return;
    }
    const { id } = request.params as { id: string };
    const body = request.body ?? {};
    if (!Value.Check(HookPayloadSchema, body)) {
      await reply.code(400).send(openAiError(400, "webhook payload must be { content, title?, model? }", "invalid_request_error"));
      return;
    }
    const payload = body as HookPayload;
    const sigRaw = request.headers["x-foundry-signature"];
    const signature = Array.isArray(sigRaw) ? sigRaw[0] : sigRaw;
    const trigger = deps.hooks.trigger(
      id,
      (request as AuthedRequest).rawBody ?? Buffer.alloc(0),
      signature,
      payload,
    );
    if (trigger === undefined) {
      await reply.code(404).send(openAiError(404, `unknown hook: ${id}`, "not_found_error"));
      return;
    }
    if (!trigger.ok) {
      await reply.code(401).send(openAiError(401, `webhook rejected: ${trigger.reason}`, "authentication_error"));
      return;
    }
    return { ok: true, runId: trigger.runId, conversationId: trigger.conversationId };
  });

  // -- admin: schedules (P3) -----------------------------------------------------

  app.get("/v1/admin/schedules", async (request) => {
    const user = (request as AuthedRequest).user;
    if (!user) return { schedules: [] };
    return { schedules: deps.schedules?.list(user.userId) ?? [] };
  });

  app.get("/v1/admin/schedules/:id", async (request, reply) => {
    const user = (request as AuthedRequest).user;
    if (!user) return;
    const { id } = request.params as { id: string };
    const schedule = deps.schedules?.get(user.userId, id);
    if (schedule === undefined) {
      await reply.code(404).send(openAiError(404, `unknown schedule: ${id}`, "not_found_error"));
      return;
    }
    return schedule;
  });

  app.post("/v1/admin/schedules", async (request, reply) => {
    if (!deps.schedules) {
      await reply.code(503).send(openAiError(503, "scheduler service unavailable", "api_error"));
      return;
    }
    const user = (request as AuthedRequest).user;
    if (!user) return;
    const body = request.body ?? {};
    if (!Value.Check(ScheduleCreateParamsSchema, body)) {
      await reply.code(400).send(openAiError(400, "invalid schedule params (name, kind, spec, prompt required)", "invalid_request_error"));
      return;
    }
    const p = body as ScheduleCreateParams;
    try {
      const made = deps.schedules.create({
        userId: user.userId,
        name: p.name,
        // value-validated above against ScheduleKindSchema (cron | every).
        kind: p.kind === "every" ? ("every" as const) : ("cron" as const),
        spec: p.spec,
        prompt: p.prompt,
        ...(p.model !== undefined ? { model: p.model } : {}),
        ...(p.targetChatId !== undefined ? { targetChatId: p.targetChatId } : {}),
        ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
      });
      reply.code(201);
      deps.audit?.record({ userId: user.userId, action: "admin.schedules.create", target: String((made as { id?: string }).id ?? ""), meta: { kind: p.kind, spec: p.spec } });
      return made;
    } catch (err) {
      await reply.code(400).send(openAiError(400, err instanceof Error ? err.message : "invalid schedule spec", "invalid_request_error"));
      return;
    }
  });

  app.patch("/v1/admin/schedules/:id", async (request, reply) => {
    if (!deps.schedules) {
      await reply.code(503).send(openAiError(503, "scheduler service unavailable", "api_error"));
      return;
    }
    const user = (request as AuthedRequest).user;
    if (!user) return;
    const { id } = request.params as { id: string };
    const body = request.body ?? {};
    if (!Value.Check(SchedulePatchParamsSchema, body)) {
      await reply.code(400).send(openAiError(400, "invalid schedule patch params", "invalid_request_error"));
      return;
    }
    const p = body as SchedulePatchParams;
    try {
      const updated = deps.schedules.patch(user.userId, id, {
        ...(p.name !== undefined ? { name: p.name } : {}),
        ...(p.prompt !== undefined ? { prompt: p.prompt } : {}),
        ...(p.spec !== undefined ? { spec: p.spec } : {}),
        ...(p.model !== undefined ? { model: p.model } : {}),
        ...(p.targetChatId !== undefined ? { targetChatId: p.targetChatId } : {}),
        ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
        ...(p.reschedule !== undefined ? { reschedule: p.reschedule } : {}),
      });
      if (updated === undefined) {
        await reply.code(404).send(openAiError(404, `unknown schedule: ${id}`, "not_found_error"));
        return;
      }
      deps.audit?.record({ userId: user.userId, action: "admin.schedules.update", target: id, meta: { fields: Object.keys(body as Record<string, unknown>) } });
      return updated;
    } catch (err) {
      await reply.code(400).send(openAiError(400, err instanceof Error ? err.message : "invalid schedule spec", "invalid_request_error"));
      return;
    }
  });

  app.delete("/v1/admin/schedules/:id", async (request, reply) => {
    if (!deps.schedules) {
      await reply.code(503).send(openAiError(503, "scheduler service unavailable", "api_error"));
      return;
    }
    const user = (request as AuthedRequest).user;
    if (!user) return;
    const { id } = request.params as { id: string };
    const ok = deps.schedules.remove(user.userId, id);
    if (!ok) {
      await reply.code(404).send(openAiError(404, `unknown schedule: ${id}`, "not_found_error"));
      return;
    }
    deps.audit?.record({ userId: user.userId, action: "admin.schedules.delete", target: id });
    return { ok: true };
  });

  // -- admin: webhooks (P3; secret shown exactly once) ---------------------------

  app.get("/v1/admin/hooks", async (request) => {
    const user = (request as AuthedRequest).user;
    if (!user) return { hooks: [] };
    return { hooks: deps.hooks?.list(user.userId) ?? [] };
  });

  app.post("/v1/admin/hooks", async (request, reply) => {
    if (!deps.hooks) {
      await reply.code(503).send(openAiError(503, "hooks service unavailable", "api_error"));
      return;
    }
    const user = (request as AuthedRequest).user;
    if (!user) return;
    const body = request.body ?? {};
    if (!Value.Check(HookCreateParamsSchema, body)) {
      await reply.code(400).send(openAiError(400, "invalid hook params (name required)", "invalid_request_error"));
      return;
    }
    const p = body as HookCreateParams;
    const made = deps.hooks.create(user.userId, p.name, p.model ?? null);
    // `secret` appears exactly once — never stored in plaintext, never echoed.
    deps.audit?.record({ userId: user.userId, action: "admin.hooks.create", target: made.hook.id, meta: { name: p.name } });
    reply.code(201);
    return made;
  });

  app.delete("/v1/admin/hooks/:id", async (request, reply) => {
    if (!deps.hooks) {
      await reply.code(503).send(openAiError(503, "hooks service unavailable", "api_error"));
      return;
    }
    const user = (request as AuthedRequest).user;
    if (!user) return;
    const { id } = request.params as { id: string };
    const ok = deps.hooks.remove(user.userId, id);
    if (!ok) {
      await reply.code(404).send(openAiError(404, `unknown hook: ${id}`, "not_found_error"));
      return;
    }
    deps.audit?.record({ userId: user.userId, action: "admin.hooks.delete", target: id });
    return { ok: true };
  });

  // -- P5: audit log + backups (admin read/trigger) -----------------------------

  app.get("/v1/admin/audit", async (request) => {
    if (!deps.audit) return { events: [] };
    const q = request.query as { limit?: string };
    const limit = typeof q.limit === "string" ? Number(q.limit) : undefined;
    return { events: deps.audit.list(Number.isFinite(limit) ? limit : undefined) };
  });

  app.post("/v1/admin/backup", async (request, reply) => {
    if (!deps.backup) {
      await reply.code(503).send(openAiError(503, "backup service unavailable", "api_error"));
      return;
    }
    const user = (request as AuthedRequest).user;
    try {
      const result = await deps.backup.runOnce();
      deps.audit?.record({ ...(user !== undefined ? { userId: user.userId } : {}), action: "admin.backup", target: result.dir, meta: { dbBytes: result.dbBytes, blobFiles: result.blobFiles } });
      return result;
    } catch (err) {
      // A busy slot is not a server fault — 409 tells the caller to retry.
      if (err instanceof Error && err.message === "backup already running") {
        await reply.code(409).send(openAiError(409, "a backup is already running", "api_error"));
        return;
      }
      await reply.code(500).send(openAiError(500, err instanceof Error ? err.message : "backup failed", "api_error"));
    }
  });

  app.get("/v1/admin/backups", async () => {
    return { backups: deps.backup?.list() ?? [] };
  });
}

/** Accept `content: null` (OpenAI tool-call turns) by normalizing to "". */
function normalizeMessage(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const m = { ...(raw as Record<string, unknown>) };
  if (m["content"] === null) m["content"] = "";
  return m;
}

function toOpenAiResponse(wireModel: string, result: Awaited<ReturnType<ChatService["runChat"]>>): Record<string, unknown> {
  return {
    id: `chatcmpl-foundry-${result.runId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: wireModel,
    choices: [
      {
        index: 0,
        message: result.message,
        finish_reason: result.finishReason,
      },
    ],
    usage: result.usage,
  };
}

function usageOnlyChunk(model: string, usage: Usage): Record<string, unknown> {
  return {
    id: `chatcmpl-foundry-usage`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage,
  };
}