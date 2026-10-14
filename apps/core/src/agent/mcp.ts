import { env as processEnv } from "node:process";
import { Type, type Static } from "@sinclair/typebox";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { eq } from "drizzle-orm";
import type { FoundryDb } from "../db/open.js";
import { settings } from "../db/schema.js";
import type { AgentTool, ToolResult } from "./tools.js";
import { ToolInputError } from "./tools.js";

/**
 * MCP client manager (ADR-006, build-order P2 task 6). Settings-driven stdio
 * servers: `settings["mcp.servers"] = [{name, command, args?, env?}]`. Each
 * server connects at boot (or via `reload()` after the admin endpoint edits
 * the list); its tools join the agent tool registry namespaced
 * `mcp__<server>__<tool>`. A server that fails to start is skipped (logged,
 * surfaced in `status()` + `GET /v1/admin/mcp/servers`) — never fatal to core
 * or to a run that doesn't need its tools.
 */

export const McpServerSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_.-]+$" }),
  command: Type.String({ minLength: 1 }),
  args: Type.Optional(Type.Array(Type.String())),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export type McpServer = Static<typeof McpServerSchema>;

export const MCP_SETTINGS_KEY = "mcp.servers";

/** Child MCP servers are owner-configured host processes — PATH/HOME must
 * reach them so `npx`-style launchers work; user vars override. */
const MCP_DEFAULT_ENV_KEYS = ["PATH", "HOME", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE"] as const;

interface McpServerState {
  server: McpServer;
  client?: McpClient;
  tools: { name: string; title?: string; description?: string; inputSchema?: unknown }[];
  error?: string;
}

export interface McpStatus {
  name: string;
  connected: boolean;
  tools: number;
  error?: string;
}

export class McpManager {
  private readonly states = new Map<string, McpServerState>();
  private loading: Promise<void> | undefined;

  constructor(private readonly deps: { dbx: FoundryDb; log?: (obj: object, msg: string) => void }) {}

  private readServers(): McpServer[] {
    const row = this.deps.dbx.db.select().from(settings).where(eq(settings.key, MCP_SETTINGS_KEY)).get();
    let parsed: unknown = row?.value;
    if (typeof parsed === "string" && parsed.length > 0) {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        return [];
      }
    }
    if (Array.isArray(parsed)) return parsed as McpServer[]; // validated on write
    return [];
  }

  /**
   * Persist the full server list (admin PUT). Callers must have validated
   * each entry against McpServerSchema; the settings column is json-mode, so
   * drizzle serializes the array to text itself.
   */
  setServers(servers: McpServer[]): void {
    this.deps.dbx.db
      .insert(settings)
      .values({ key: MCP_SETTINGS_KEY, value: servers })
      .onConflictDoUpdate({ target: settings.key, set: { value: servers } })
      .run();
  }

  /** Connect (or reconnect) to all configured servers. Idempotent. */
  async reload(): Promise<void> {
    if (this.loading !== undefined) return this.loading;
    this.loading = this.reloadInner().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async reloadInner(): Promise<void> {
    const servers = this.readServers();
    await Promise.allSettled(servers.map((s) => this.connectOne(s)));
  }

  private async connectOne(server: McpServer): Promise<void> {
    const previous = this.states.get(server.name);
    if (previous?.client !== undefined && previous.server.command === server.command &&
        JSON.stringify(previous.server.args ?? []) === JSON.stringify(server.args ?? [])) {
      this.states.set(server.name, { ...previous, server }); // env-only edits don't need a reconnect
      return;
    }
    if (previous?.client !== undefined) await this.shutdownOne(server.name);
    const state: McpServerState = { server, tools: [] };
    this.states.set(server.name, state);
    try {
      const client = new McpClient({ name: "foundry", version: "0" });
      const transport = new StdioClientTransport({
        command: server.command,
        ...(server.args !== undefined ? { args: server.args } : {}),
        env: {
          ...Object.fromEntries(MCP_DEFAULT_ENV_KEYS.flatMap((k) => (processEnv[k] !== undefined ? [[k, processEnv[k] as string] as const] : []))),
          ...(server.env ?? {}),
        },
      });
      await client.connect(transport);
      const list = await client.listTools();
      state.tools = (list.tools as { name: string; title?: string; description?: string; inputSchema?: unknown }[]).slice(0, 100);
      state.client = client;
      this.deps.log?.({ mod: "mcp", server: server.name }, `connected: ${state.tools.length} tools`);
    } catch (err) {
      state.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.deps.log?.({ mod: "mcp", server: server.name, err: state.error }, "mcp server failed to connect");
    }
  }

  private async shutdownOne(name: string): Promise<void> {
    const state = this.states.get(name);
    this.states.delete(name);
    await state?.client?.close().catch(() => {});
  }

  /** Close every stdio transport (shutdown / tests). */
  async close(): Promise<void> {
    const names = [...this.states.keys()];
    await Promise.allSettled(names.map((n) => this.shutdownOne(n)));
  }

  /** Currently-available MCP tools, namespaced `mcp__<server>__<tool>`. */
  tools(): AgentTool[] {
    const out: AgentTool[] = [];
    for (const state of this.states.values()) {
      if (state.client === undefined) continue;
      for (const tool of state.tools) {
        const toolName = tool.name;
        out.push({
          def: {
            type: "function",
            function: {
              name: `mcp__${state.server.name}__${toolName}`,
              ...(tool.description !== undefined && tool.description.length > 0 ? { description: tool.description } : {}),
              parameters: tool.inputSchema ?? { type: "object" },
            },
          },
          execute: async (args) => {
            const client = this.states.get(state.server.name)?.client;
            if (client === undefined) return { content: `mcp server "${state.server.name}" is not connected`, isError: true };
            return this.call(client, toolName, args);
          },
        });
      }
    }
    return out;
  }

  status(): McpStatus[] {
    return [...this.states.values()].map((s) => ({
      name: s.server.name,
      connected: s.client !== undefined,
      tools: s.tools.length,
      ...(s.error !== undefined ? { error: s.error } : {}),
    }));
  }

  private async call(client: McpClient, name: string, args: unknown): Promise<ToolResult> {
    if (typeof args !== "object" || args === null) throw new ToolInputError("mcp tool args must be a JSON object");
    const res = await client.callTool({ name, arguments: args as Record<string, unknown> });
    const text = joinContent(res.content);
    return { content: text, isError: res.isError === true ? true : undefined };
  }
}

/** MCP tool content is a data array (text/image/resource); we surface text. */
function joinContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "(empty mcp result)";
  const parts: string[] = [];
  for (const c of content) {
    if (c !== null && typeof c === "object" && "type" in c) {
      const t = c as { type: string; text?: unknown };
      if (t.type === "text" && typeof t.text === "string") parts.push(t.text);
      else parts.push(`[${t.type} content omitted]`);
    }
  }
  return parts.join("\n").length > 0 ? parts.join("\n") : "(empty mcp result)";
}