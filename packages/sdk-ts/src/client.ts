import type {
  Hook,
  Model,
  Schedule,
  ScheduleCreateParams,
  SchedulePatchParams,
} from "@foundry/protocol";
import { FoundryError } from "./errors.js";
import { FoundrySocket } from "./socket.js";

/** MCP server config as accepted by `PUT /v1/admin/mcp/servers`. */
export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
}

export class FoundryClient {
  private readonly baseUrl: string;
  private token: string | undefined;

  constructor(opts: { baseUrl?: string; token?: string; clientKind?: string; clientVersion?: string } = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:8787").replace(/\/$/, "");
    this.token = opts.token;
  }

  setToken(token: string): void {
    this.token = token;
  }

  /** Build a WS socket for this base URL + token. */
  socket(opts: { token?: string; clientKind?: string; clientVersion?: string; autoReconnect?: boolean; reconnectMaxMs?: number } = {}): FoundrySocket {
    const token = opts.token ?? this.token;
    if (token === undefined) throw new FoundryError("bad_request", "token required for WS");
    return new FoundrySocket({
      baseUrl: this.baseUrl,
      token,
      clientKind: opts.clientKind,
      clientVersion: opts.clientVersion,
      autoReconnect: opts.autoReconnect,
      reconnectMaxMs: opts.reconnectMaxMs,
    });
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        ...(this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = { raw: text };
    }
    if (!res.ok) {
      const err = (parsed as { error?: { message?: string; type?: string } } | undefined)?.error;
      throw new FoundryError(err?.type ?? "internal", err?.message ?? `${method} ${path} failed (${res.status})`, { status: res.status });
    }
    return parsed as T;
  }

  // -- health / auth / models ---------------------------------------------------

  health(): Promise<{ ok: boolean; version: string; uptimeS?: number }> {
    return this.json("GET", "/healthz");
  }

  ready(): Promise<{ ok: boolean }> {
    return this.json("GET", "/readyz");
  }

  /** ADR-006: user-facing login = username + password → session token. */
  login(username: string, password: string): Promise<{ sessionToken: string; expiresAt: string }> {
    return this.json("POST", "/v1/auth/login", { username, password });
  }

  /** ADR-006: self-service password change (session-authenticated). */
  changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
    return this.json("POST", "/v1/auth/password", { currentPassword, newPassword });
  }

  /** ADR-015: push a local chat's workspace + deps into a backend env. The
   * response returns immediately; progress streams on the chat's run. */
  pushChat(chatId: string): Promise<{ pushRunId: string; cloudEnvId: string }> {
    return this.json("POST", `/v1/chats/${encodeURIComponent(chatId)}/push`, {});
  }

  models(): Promise<{ object: string; data: Model[] }> {
    return this.json("GET", "/v1/models");
  }

  // -- openai-compatible chat ----------------------------------------------------

  /** Non-stream OpenAI-compatible completion (typed loosely — full passthrough). */
  chat(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.json("POST", "/v1/chat/completions", body);
  }

  /** Streaming SSE completion — yields chunk objects, ends after [DONE]. */
  async *chatStream(body: Record<string, unknown>): AsyncGenerator<Record<string, unknown>> {
    const res = await fetch(this.baseUrl + "/v1/chat/completions", {
      method: "POST",
      headers: {
        ...(this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || res.body === null) {
      const text = res.body === null ? "" : await res.text();
      const parsed = (JSON.parse(text || "{}") as { error?: { message?: string; type?: string } } | undefined) ?? {};
      throw new FoundryError(parsed.error?.type ?? "internal", parsed.error?.message ?? `chat failed (${res.status})`, { status: res.status });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data) as Record<string, unknown>;
        } catch {
          // keep-alive or non-JSON line — skip
        }
      }
    }
  }

  // -- admin: providers / keys -----------------------------------------------

  adminUpsertProvider(body: {
    id?: string;
    kind: string;
    baseUrl?: string;
    apiKey?: string;
    models?: { id: string; name?: string; context?: number; caps?: Record<string, boolean>; priceIn?: number; priceOut?: number }[];
  }): Promise<{ id: string; models: string[] }> {
    return this.json("POST", "/v1/admin/providers", body);
  }

  adminListProviders(): Promise<{ providers: { id: string; kind: string; baseUrl: string | null; enabled: boolean; hasKey: boolean }[] }> {
    return this.json("GET", "/v1/admin/providers");
  }

  adminDeleteProvider(id: string): Promise<{ ok: boolean }> {
    return this.json("DELETE", `/v1/admin/providers/${encodeURIComponent(id)}`);
  }

  adminCreateKey(name?: string): Promise<{ id: string; name: string; key: string }> {
    return this.json("POST", "/v1/admin/keys", { ...(name !== undefined ? { name } : {}) });
  }

  adminListKeys(): Promise<{ keys: { id: string; name: string }[] }> {
    return this.json("GET", "/v1/admin/keys");
  }

  adminRevokeKey(id: string): Promise<{ ok: boolean }> {
    return this.json("DELETE", `/v1/admin/keys/${encodeURIComponent(id)}`);
  }

  // -- admin: MCP servers -----------------------------------------------------

  adminGetMcpServers(): Promise<{ status: { name: string; connected: boolean; tools: number; error?: string }[] }> {
    return this.json("GET", "/v1/admin/mcp/servers");
  }

  adminPutMcpServers(servers: McpServerConfig[]): Promise<{ ok: boolean; count: number }> {
    return this.json("PUT", "/v1/admin/mcp/servers", { servers });
  }

  // -- admin: schedules (P3) ------------------------------------------------------

  adminListSchedules(): Promise<{ schedules: Schedule[] }> {
    return this.json("GET", "/v1/admin/schedules");
  }

  adminGetSchedule(id: string): Promise<Schedule> {
    return this.json("GET", `/v1/admin/schedules/${encodeURIComponent(id)}`);
  }

  adminCreateSchedule(params: ScheduleCreateParams): Promise<Schedule> {
    return this.json("POST", "/v1/admin/schedules", params);
  }

  adminPatchSchedule(id: string, params: SchedulePatchParams): Promise<Schedule> {
    return this.json("PATCH", `/v1/admin/schedules/${encodeURIComponent(id)}`, params);
  }

  adminDeleteSchedule(id: string): Promise<{ ok: boolean }> {
    return this.json("DELETE", `/v1/admin/schedules/${encodeURIComponent(id)}`);
  }

  // -- admin: webhook hooks (P3 — secret shown exactly once) -----------------------

  adminCreateHook(name: string, model?: string | null): Promise<{ hook: Hook; secret: string; url: string }> {
    return this.json("POST", "/v1/admin/hooks", { name, ...(model !== undefined && model !== null ? { model } : {}) });
  }

  adminListHooks(): Promise<{ hooks: Hook[] }> {
    return this.json("GET", "/v1/admin/hooks");
  }

  adminDeleteHook(id: string): Promise<{ ok: boolean }> {
    return this.json("DELETE", `/v1/admin/hooks/${encodeURIComponent(id)}`);
  }
}