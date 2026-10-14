import type { Message } from "@foundry/protocol";
import type {
  ChatChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderAdapter,
  ProviderRequestContext,
  Usage,
} from "./types.js";

/**
 * Dummy provider — deterministic, scripted, zero network. Powers tests and
 * smoke so the whole gateway works before any real provider exists.
 *
 * Script (agent loop): with `done` in the toolset the model walks a scenario
 * keyed off the LAST user message + how many role:"tool" messages are in
 * history — unit + integration specs drive full loops with no model round
 * trips:
 *  - "gate-me"        → shell `rm -rf ./build` (P3 gate flow parks the run)
 *  - "remember-me: X" → memory tool store of X
 *  - "search-me: Q"   → memory tool search of Q
 *  - "recall-me"      → pure-text stop (memory injection lands via system)
 *  - "sky-report"     → pure-text stop (schedule/webhook acceptance prompt)
 *  - MCP tools present→ call the first MCP tool once, then finish
 *  - anything else    → create hello.py, run python3 hello.py, finish (P2)
 * Without `done` in the toolset: one tool_call to the first tool (P1) or an
 * echo of the last user text. Usage is deterministic (chars/4, min 1).
 * Model id containing "-slow" adds 120ms/chunk (mid-stream kill testing).
 * `embed` is a deterministic bag-of-tokens hash embedding (768 dims), stable
 * across processes, so memory specs can assert similarity without a model.
 */

const CREATED = 1_700_000_000; // deterministic timestamp
export const DUMMY_EMBED_DIMS = 768;

/** FNV-1a per token + bag-of-indexes; L2-normalized. Deterministic everywhere. */
function hashEmbed(text: string): number[] {
  const v = new Array<number>(DUMMY_EMBED_DIMS).fill(0);
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    const bin = h % DUMMY_EMBED_DIMS;
    v[bin] = (v[bin] ?? 0) + 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function estimateUsage(promptChars: number, completionChars: number): Usage {
  const p = Math.max(1, Math.ceil(promptChars / 4));
  const c = Math.max(1, Math.ceil(completionChars / 4));
  return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") {
      return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    }
  }
  return "";
}

function promptChars(messages: Message[]): number {
  return messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 64), 0);
}

interface Script {
  text: string;
  toolCall?: { id: string; name: string; arguments: string };
  finishReason: "stop" | "tool_calls";
  usage: Usage;
}

function scriptFor(req: ChatCompletionRequest): Script {
  const toolNames = (req.tools ?? []).map((t) => t.function.name);
  if (toolNames.length > 0) {
    const toolMsgs = req.messages.filter((m) => m.role === "tool").length;
    // P3 scenarios key off the last user prompt; everything else falls through
    // to the P2 hello.py loop.
    const lastUser = lastUserText(req.messages);
    const stop = (text: string): Script => ({
      text,
      finishReason: "stop",
      usage: estimateUsage(promptChars(req.messages), text.length),
    });
    if (toolNames.includes("done")) {
      if (lastUser.includes("gate-me")) {
        if (toolMsgs === 0) {
          return {
            text: "Proposing a destructive command.",
            toolCall: {
              id: "call_dummy_gate",
              name: "shell",
              arguments: JSON.stringify({ command: "rm -rf ./build" }),
            },
            finishReason: "tool_calls",
            usage: estimateUsage(promptChars(req.messages), 40),
          };
        }
        return stop("Handled the gated command.");
      }
      if (lastUser.includes("remember-me:")) {
        const fact = lastUser.slice(lastUser.indexOf("remember-me:") + "remember-me:".length).trim();
        if (toolMsgs === 0) {
          return {
            text: "Storing to memory.",
            toolCall: {
              id: "call_dummy_mem",
              name: "memory",
              arguments: JSON.stringify({ action: "store", content: fact }),
            },
            finishReason: "tool_calls",
            usage: estimateUsage(promptChars(req.messages), 40),
          };
        }
        return stop("Stored to memory.");
      }
      if (lastUser.includes("search-me:")) {
        const q = lastUser.slice(lastUser.indexOf("search-me:") + "search-me:".length).trim();
        if (toolMsgs === 0) {
          return {
            text: "Searching memory.",
            toolCall: {
              id: "call_dummy_memq",
              name: "memory",
              arguments: JSON.stringify({ action: "search", query: q }),
            },
            finishReason: "tool_calls",
            usage: estimateUsage(promptChars(req.messages), 40),
          };
        }
        return stop("Search done.");
      }
      if (lastUser.includes("recall-me") || lastUser.includes("sky-report")) {
        return stop("Recalled from memory and ready.");
      }
      const mcpToolName = toolNames.find((n) => n.startsWith("mcp__"));
      if (mcpToolName !== undefined) {
        // MCP scenario: call the first MCP tool once, then finish.
        if (toolMsgs === 0) {
          return {
            text: "Calling the MCP tool.",
            toolCall: {
              id: "call_dummy_mcp",
              name: mcpToolName,
              arguments: JSON.stringify({ message: "ping from the agent" }),
            },
            finishReason: "tool_calls",
            usage: estimateUsage(promptChars(req.messages), 40),
          };
        }
        return stop("The MCP tool replied. Done.");
      }
      if (toolMsgs === 0) {
        return {
          text: "Creating hello.py.",
          toolCall: {
            id: "call_dummy_01",
            name: "fs_write",
            arguments: JSON.stringify({ path: "hello.py", content: "print('hello from the sandbox')\n" }),
          },
          finishReason: "tool_calls",
          usage: estimateUsage(promptChars(req.messages), 40),
        };
      }
      if (toolMsgs === 1) {
        return {
          text: "Running it.",
          toolCall: {
            id: "call_dummy_02",
            name: "shell",
            arguments: JSON.stringify({ command: "python3 hello.py" }),
          },
          finishReason: "tool_calls",
          usage: estimateUsage(promptChars(req.messages), 40),
        };
      }
      return stop("Done: created hello.py and ran it.");
    }
    const tool = req.tools?.[0];
    if (tool) {
      return {
        text: "Calling a tool for you.",
        toolCall: {
          id: "call_dummy_01",
          name: tool.function.name,
          arguments: JSON.stringify({ action: "default" }),
        },
        finishReason: "tool_calls",
        usage: estimateUsage(promptChars(req.messages), 40),
      };
    }
  }
  const text = `You said: "${lastUserText(req.messages)}"`;
  return {
    text,
    finishReason: "stop",
    usage: estimateUsage(promptChars(req.messages), text.length),
  };
}

function deltaChunk(req: ChatCompletionRequest, delta: ChatChunk["choices"][number]["delta"], finish: string | null): ChatChunk {
  return {
    id: `chatcmpl-dummy-${CREATED.toString(36)}`,
    object: "chat.completion.chunk",
    created: CREATED,
    model: req.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function splitWords(text: string): string[] {
  return text.split(/(\s+)/).filter((w: string) => w.length > 0);
}

async function* streamedChunks(req: ChatCompletionRequest, delayMs: number): AsyncGenerator<ChatChunk> {
  const s = scriptFor(req);
  for (const word of splitWords(s.text)) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    yield deltaChunk(req, { content: word }, null);
  }
  if (s.toolCall) {
    yield deltaChunk(req, { tool_calls: [{ index: 0, id: s.toolCall.id, type: "function", function: { name: s.toolCall.name, arguments: "" } }] }, null);
    yield deltaChunk(req, { tool_calls: [{ index: 0, function: { arguments: s.toolCall.arguments } }] }, null);
  }
  yield deltaChunk(req, {}, s.finishReason);
  yield { ...deltaChunk(req, {}, s.finishReason), choices: [], usage: s.usage };
}

function toResponse(req: ChatCompletionRequest, s: Script): ChatCompletionResponse {
  const message: ChatCompletionResponse["choices"][number]["message"] = {
    role: "assistant",
    content: s.text,
  };
  if (s.toolCall) {
    message.tool_calls = [
      {
        id: s.toolCall.id,
        type: "function",
        function: {
          name: s.toolCall.name,
          arguments: s.toolCall.arguments,
        },
      },
    ];
  }
  return {
    id: `chatcmpl-dummy-${CREATED.toString(36)}`,
    object: "chat.completion",
    created: CREATED,
    model: req.model,
    choices: [{ index: 0, message, finish_reason: s.finishReason }],
    usage: s.usage,
  };
}

export function createDummyAdapter(): ProviderAdapter {
  return {
    async *chatStream(req: ChatCompletionRequest, _ctx: ProviderRequestContext) {
      const delayMs = req.model.includes("-slow") ? 120 : 0;
      yield* streamedChunks(req, delayMs);
    },
    async chatOnce(req: ChatCompletionRequest) {
      return toResponse(req, scriptFor(req));
    },
    async embed(texts: string[]) {
      return texts.map(hashEmbed);
    },
  };
}