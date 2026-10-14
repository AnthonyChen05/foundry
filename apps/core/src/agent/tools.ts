import type { ToolDefinition } from "../providers/types.js";
import type { EnvHandle, ExecResult } from "../sandbox/types.js";
import { SandboxError } from "../sandbox/types.js";

/**
 * Agent builtin tools (build-order P2 task 3): shell, fs.*, fetch, done.
 * Every tool that touches the filesystem or processes goes through the
 * sandbox driver (guardrail #1) — `fetch` is the one gateway-side exception
 * (a read-only, size-capped HTTP GET; its output is data, never instructions).
 *
 * Tool outputs are truncated to TOOL_OUTPUT_MAX chars before they land in the
 * loop context — a runaway `cat` must not eat the model's context or the
 * run_events row budget.
 */

export const TOOL_OUTPUT_MAX = 16_000;

/** Tool parameters come from the model as unvalidated JSON — gate strictly. */
export class ToolInputError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ToolInputError";
  }
}

export interface ToolContext {
  env: EnvHandle;
  signal: AbortSignal;
  /** Run owner (memory tool scoping; set by the agent runtime). */
  userId?: string;
  /** Source run (memory sourceRunId provenance; set by the agent runtime). */
  runId?: string;
  /** Conversation the run belongs to (set by the agent runtime). */
  chatId?: string;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface AgentTool {
  def: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** P2 policy: everything runs (`always`); explicit `deny` blocks the call. */
export type ToolPolicyValue = "ask" | "always" | "session" | "deny";

export function resolvePolicy(opts: {
  toolName: string;
  policyMap?: Record<string, unknown>;
}): ToolPolicyValue {
  const raw = opts.policyMap?.[opts.toolName];
  if (raw === "deny" || raw === "ask" || raw === "always" || raw === "session") {
    return raw;
  }
  return "always"; // P2 default (build-order: run.gate_request not yet required)
}

// -- helpers -------------------------------------------------------------------

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ToolInputError(`tool args require a non-empty string "${key}"`);
  }
  return v;
}

function numArg(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function optStrArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function truncate(text: string, marker?: string): string {
  if (text.length <= TOOL_OUTPUT_MAX) return text;
  const head = `${text.slice(0, TOOL_OUTPUT_MAX)}`;
  return `${head}\n…[truncated${marker !== undefined ? `: ${marker}` : ""}]`;
}

function joinChunks(parts: string[]): string {
  return parts.join("");
}

function execToContent(r: ExecResult): string {
  const lines = [`exit_code: ${r.exitCode ?? "killed"}`];
  if (r.timedOut) lines.push("timed_out: true");
  const out = joinChunks([r.stdout, r.stderr]);
  if (out.length > 0) lines.push(out);
  else lines.push("(no output)");
  return truncate(lines.join("\n"), "shell output");
}

// -- tools -----------------------------------------------------------------------

export function builtinAgentTools(): AgentTool[] {
  return [
    {
      def: {
        type: "function",
        function: {
          name: "shell",
          description:
            "Run a POSIX shell command inside the sandbox workspace (cwd = workspace root). " +
            "Merged stdout+stderr come back with the exit code. Use for builds, scripts, git, package managers.",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "Shell command to run." },
              timeout_s: { type: "integer", description: "Timeout in seconds (default 60, max 300)." },
            },
            required: ["command"],
          },
        },
      },
      execute: async (args, ctx) => {
        const command = strArg(args, "command");
        const timeoutS = Math.min(Math.max(numArg(args, "timeout_s") ?? 60, 1), 300);
        const r = await ctx.env.driver.execShell(ctx.env.envId, command, { timeoutMs: timeoutS * 1000 });
        return { content: execToContent(r), isError: r.exitCode !== 0 ? true : undefined };
      },
    },
    {
      def: {
        type: "function",
        function: {
          name: "fs_list",
          description: "List a directory in the sandbox workspace (default: root).",
          parameters: {
            type: "object",
            properties: { path: { type: "string", description: "Directory path (workspace-relative)." } },
          },
        },
      },
      execute: async (args, ctx) => {
        const path = optStrArg(args, "path") ?? ".";
        const files = await ctx.env.driver.files.list(ctx.env.envId, path);
        if (files.length === 0) return { content: `${path}: (empty)` };
        const lines = files.map((f) => `${f.isDir ? "d" : "f"}  ${String(f.size).padStart(10)}  ${f.path}`);
        return { content: truncate(lines.join("\n"), "directory listing") };
      },
    },
    {
      def: {
        type: "function",
        function: {
          name: "fs_read",
          description:
            "Read a text file in the sandbox workspace. Optional 1-based line range for big files — " +
            "read ranges in chunks rather than whole huge files.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path (workspace-relative)." },
              start_line: { type: "integer", description: "First line to include (1-based)." },
              end_line: { type: "integer", description: "Last line to include (inclusive, 1-based)." },
            },
            required: ["path"],
          },
        },
      },
      execute: async (args, ctx) => {
        const path = strArg(args, "path");
        const { content, isText } = await ctx.env.driver.files.read(ctx.env.envId, path);
        if (!isText) {
          return { content: `binary file: ${path} (${content.length} bytes)`, isError: true };
        }
        const startLine = numArg(args, "start_line");
        const endLine = numArg(args, "end_line");
        let text = content.toString("utf8");
        if (startLine !== undefined || endLine !== undefined) {
          const lines = text.split("\n");
          const s = Math.max(startLine ?? 1, 1);
          const e = endLine ?? lines.length;
          const slice = lines.slice(s - 1, e).join("\n");
          text = `lines ${s}-${Math.min(e, lines.length)} of ${lines.length}\n${slice}`;
        }
        return { content: truncate(text, "file content") };
      },
    },
    {
      def: {
        type: "function",
        function: {
          name: "fs_write",
          description: "Create or overwrite a UTF-8 text file in the sandbox workspace. Parent dirs are NOT created — mkdir first.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path (workspace-relative)." },
              content: { type: "string", description: "Full file contents." },
            },
            required: ["path", "content"],
          },
        },
      },
      execute: async (args, ctx) => {
        const path = strArg(args, "path");
        const content = strArg(args, "content");
        const st = await ctx.env.driver.files.write(ctx.env.envId, path, Buffer.from(content, "utf8"));
        return { content: `wrote ${st.path} (${st.size} bytes)` };
      },
    },
    {
      def: {
        type: "function",
        function: {
          name: "fs_mkdir",
          description: "Create a directory (parents created by default).",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Directory path (workspace-relative)." },
              recursive: { type: "boolean", description: "default true" },
            },
            required: ["path"],
          },
        },
      },
      execute: async (args, ctx) => {
        const path = strArg(args, "path");
        const recursive = args["recursive"] !== false;
        await ctx.env.driver.files.mkdir(ctx.env.envId, path, recursive);
        return { content: `created ${path}` };
      },
    },
    {
      def: {
        type: "function",
        function: {
          name: "fs_rm",
          description: "Remove a file or directory. Directories need recursive.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path (workspace-relative)." },
              recursive: { type: "boolean", description: "Remove directories recursively." },
            },
            required: ["path"],
          },
        },
      },
      execute: async (args, ctx) => {
        const path = strArg(args, "path");
        const recursive = args["recursive"] === true;
        await ctx.env.driver.files.rm(ctx.env.envId, path, recursive);
        return { content: `removed ${path}` };
      },
    },
    {
      def: {
        type: "function",
        function: {
          name: "fs_stat",
          description: "Stat a path in the sandbox workspace (size, mtime, is it a directory).",
          parameters: {
            type: "object",
            properties: { path: { type: "string", description: "Path (workspace-relative)." } },
            required: ["path"],
          },
        },
      },
      execute: async (args, ctx) => {
        const path = strArg(args, "path");
        const st = await ctx.env.driver.files.stat(ctx.env.envId, path);
        return { content: `${st.path}  ${st.isDir ? "dir" : "file"}  ${st.size} bytes  mtime=${new Date(st.mtimeMs).toISOString()}` };
      },
    },
    {
      def: {
        type: "function",
        function: {
          name: "fetch",
          description:
            "HTTP GET a URL through the gateway (read-only). Text and JSON bodies are returned as data; " +
            "binary bodies are rejected. Size-capped. No credentials are sent.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "http(s) URL to GET." },
              max_bytes: { type: "integer", description: "Response cap in bytes (default 65536, max 262144)." },
            },
            required: ["url"],
          },
        },
      },
      execute: async (args, ctx) => {
        const url = strArg(args, "url");
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new ToolInputError(`invalid url: ${url}`);
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new ToolInputError(`fetch supports http(s) only: ${parsed.protocol}`);
        }
        const maxBytes = Math.min(Math.max(numArg(args, "max_bytes") ?? 65_536, 64), 262_144);
        // Gateway-side GET (build-order P2 task 3 names `fetch` a tool): aborts
        // stop with the run; the body is DATA — the agent must never treat it
        // as instructions. No credentials, no redirects that leak tokens.
        const res = await fetch(parsed.toString(), {
          method: "GET",
          redirect: "follow",
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]),
        });
        const ctype = res.headers.get("content-type") ?? "";
        const raw = await res.arrayBuffer();
        const capped = raw.byteLength > maxBytes ? raw.slice(0, maxBytes) : raw;
        const header = `status: ${res.status} ${res.statusText}\ncontent-type: ${ctype}\n\n`;
        const textLike = ctype.startsWith("text/") || ctype.includes("json") || ctype.includes("xml") || ctype.includes("javascript");
        if (!textLike) {
          return {
            content: truncate(`${header}(binary content: ${raw.byteLength}${raw.byteLength > maxBytes ? "+ truncated" : ""} bytes — fetch is text-only)`),
          };
        }
        const body = Buffer.from(capped).toString("utf8");
        return {
          content: truncate(`${header}${body}`, "fetch body"),
          isError: res.status >= 400 ? true : undefined,
        };
      },
    },
    {
      def: {
        type: "function",
        function: {
          name: "done",
          description:
            "End the run: the summary is the final answer shown to the user. Call this when the task is complete.",
          parameters: {
            type: "object",
            properties: { summary: { type: "string", description: "Final answer / outcome summary for the user." } },
            required: ["summary"],
          },
        },
      },
      execute: async (args) => {
        return { content: strArg(args, "summary") };
      },
    },
  ];
}

/** Run one tool call with policy + error shaping. Never throws. */
export async function executeToolCall(tool: AgentTool, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  try {
    if (typeof args !== "object" || args === null) throw new ToolInputError("args must be a JSON object");
    return await tool.execute(args as Record<string, unknown>, ctx);
  } catch (err) {
    if (err instanceof ToolInputError) return { content: `tool input error: ${err.message}`, isError: true };
    if (err instanceof SandboxError) return { content: `sandbox error (${err.status}): ${err.message}`, isError: true };
    if (err instanceof Error) {
      if (err.name === "AbortError" || (err as { name?: string }).name === "TimeoutError") {
        return { content: "tool cancelled", isError: true };
      }
      return { content: `tool error: ${err.message}`, isError: true };
    }
    return { content: `tool error: ${String(err)}`, isError: true };
  }
}