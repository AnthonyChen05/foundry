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
 * Script:
 *  - request has tools  -> streams a short preamble, then ONE tool_call to the
 *    first tool with arguments {"action":"default"}, finish "tool_calls".
 *  - otherwise          -> streams `You said: "<last user text>"` in word
 *    chunks, finish "stop".
 * Usage is deterministic (chars/4, min 1) so tests can assert exact values.
 * Model id containing "-slow" adds 120ms/chunk (mid-stream kill testing).
 */

const CREATED = 1_700_000_000; // deterministic timestamp

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
  };
}