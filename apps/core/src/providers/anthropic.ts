import { parseSseLines } from "./openai_compat.js";
import type { ChatChunk } from "./types.js";
import { ProviderError, type ChatCompletionRequest, type ChatCompletionResponse, type ProviderAdapter, type ProviderRequestContext, type ToolDefinition, type ToolChoice, type Usage } from "./types.js";

/**
 * Anthropic ⇄ OpenAI translation shim (ADR-002), full both directions:
 * system, tools, streaming, thinking → `reasoning_content`. Unknown payload
 * fields pass through. Translations that are inherently lossy in v0 are
 * marked with `!lossy` comments and documented in the adapter notes.
 */

const DEFAULT_MAX_TOKENS = 4096;
const CREATED = () => 1_000_000;
const shimId = () => `chatcmpl-anthropic-${CREATED().toString(36)}-${Date.now().toString(36)}`;

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: AnthropicContentBlock[] }
  | { type: "thinking"; thinking: string; signature?: string };

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  tools?: { name: string; description?: string; input_schema: unknown }[];
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string } | undefined;
  temperature?: number;
  stop_sequences?: string[];
  stream: boolean;
}

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {}; // !lossy: malformed arguments become an empty object
  }
}

function translateToolChoice(choice: ToolChoice | undefined, hasTools: boolean): AnthropicRequest["tool_choice"] {
  if (!hasTools) return undefined;
  if (choice === undefined || choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" }; // !lossy: "required" == any
  if (choice === "none") return undefined;
  if (typeof choice === "object" && choice.function?.name) return { type: "tool", name: choice.function.name };
  if (typeof choice === "object" && choice.type === "function") return { type: "any" }; // !lossy
  return { type: "auto" };
}

export function toAnthropicRequest(req: ChatCompletionRequest): AnthropicRequest {
  const out: AnthropicRequest = {
    model: req.model.replace(/^[^/]+\//, "").replace(/-slow$/, ""), // strip "<provider>/" prefix, keep raw
    max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
    messages: [],
    stream: req.stream === true,
  };
  const systems: string[] = [];
  for (const m of req.messages) {
    if (m.role === "system") {
      if (typeof m.content === "string") systems.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      // OpenAI tool result -> user turn with tool_result block
      out.messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id ?? "",
            content: [
              { type: "text", text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) },
            ],
          },
        ],
      });
      continue;
    }
    // user / assistant
    const blocks: AnthropicContentBlock[] = [];
    if (typeof m.content === "string" && m.content.length > 0) {
      blocks.push({ type: "text", text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.text) blocks.push({ type: "text", text: part.text });
        if (part.image_url) {
          const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(part.image_url.url);
          if (match) {
            blocks.push({ type: "image", source: { type: "base64", media_type: match[1] ?? "image/png", data: match[2] ?? "" } });
          } else {
            // !lossy: http(s) image urls are not fetched by the shim in v0
            blocks.push({ type: "text", text: "[unsupported image reference omitted]" });
          }
        }
      }
    }
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parseToolArguments(tc.function.arguments) });
      }
    }
    if (blocks.length === 0) blocks.push({ type: "text", text: "" }); // anthropic rejects empty content
    out.messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: blocks });
  }
  if (systems.length > 0) out.system = systems.join("\n\n");
  const defs: ToolDefinition[] | undefined = req.tools;
  if (defs && defs.length > 0) {
    if (req.tool_choice === "none") {
      // !lossy: "none" == send no tools
    } else {
      out.tools = defs
        .filter((d) => d.type === "function")
        .map((d) => ({
          name: d.function.name,
          description: d.function.description,
          input_schema: d.function.parameters,
        }));
      out.tool_choice = translateToolChoice(req.tool_choice, out.tools.length > 0);
    }
  }
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.stop !== undefined) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  return out;
}

// ---------------------------------------------------------------------------
// Response translation (non-stream)
// ---------------------------------------------------------------------------

const STOP_REASON_MAP: Record<string, string> = {
  end_turn: "stop",
  max_tokens: "length",
  stop_sequence: "stop",
  tool_use: "tool_calls",
  refusal: "content_filter",
};

export function fromAnthropicResponse(reqModel: string, raw: unknown): ChatCompletionResponse {
  const r = raw as {
    content?: { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  let text = "";
  const reasoningParts: string[] = [];
  const toolCalls: ChatCompletionResponse["choices"][number]["message"]["tool_calls"] = [];
  for (const block of r.content ?? []) {
    if (block.type === "text") text += block.text ?? "";
    else if (block.type === "thinking") reasoningParts.push(block.thinking ?? "");
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? "",
        type: "function",
        function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const message: ChatCompletionResponse["choices"][number]["message"] = {
    role: "assistant",
    content: text,
  };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const inTok = r.usage?.input_tokens ?? 0;
  const outTok = r.usage?.output_tokens ?? 0;
  return {
    id: shimId(),
    object: "chat.completion",
    created: CREATED(),
    model: reqModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: STOP_REASON_MAP[r.stop_reason ?? "end_turn"] ?? "stop",
      },
    ],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  };
}

// ---------------------------------------------------------------------------
// Stream translation
// ---------------------------------------------------------------------------

export async function* anthropicStreamToChunks(
  reqModel: string,
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<ChatChunk> {
  const id = shimId();
  let finishReason: string | null = null;
  let usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let toolIndexSeq = 0;
  const blockIndexToToolIndex = new Map<number, number>();
  let emittedFinish = false;

  const chunk = (delta: ChatChunk["choices"][number]["delta"], finish: string | null): ChatChunk => ({
    id,
    object: "chat.completion.chunk",
    created: CREATED(),
    model: reqModel,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  for await (const payload of parseSseLines(body)) {
    let evt: unknown;
    try {
      evt = JSON.parse(payload);
    } catch {
      throw new ProviderError("malformed SSE payload from anthropic", 502);
    }
    const e = evt as {
      type?: string;
      message?: { usage?: { input_tokens?: number; output_tokens?: number } };
      index?: number;
      content_block?: { type?: string; id?: string; name?: string };
      delta?: { text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: { message?: string; type?: string };
    };

    if (e.error !== undefined) {
      throw new ProviderError(`anthropic error: ${e.error.type ?? "unknown"} ${e.error.message ?? ""}`, 502);
    }

    switch (e.type) {
      case "message_start": {
        usage = {
          prompt_tokens: e.message?.usage?.input_tokens ?? 0,
          completion_tokens: 0,
          total_tokens: e.message?.usage?.input_tokens ?? 0,
        };
        break;
      }
      case "content_block_start": {
        const block = e.content_block;
        if (block?.type === "tool_use") {
          const openIndex = toolIndexSeq++;
          blockIndexToToolIndex.set(e.index ?? 0, openIndex);
          yield chunk({ tool_calls: [{ index: openIndex, id: block.id ?? "", type: "function", function: { name: block.name ?? "", arguments: "" } }] }, null);
        }
        break;
      }
      case "content_block_delta": {
        const bIdx = e.index ?? 0;
        const d = e.delta ?? {};
        if (d.text !== undefined) {
          if (d.text.length > 0) yield chunk({ content: d.text }, null);
        } else if (d.thinking !== undefined) {
          if (d.thinking.length > 0) yield chunk({ reasoning_content: d.thinking }, null);
        } else if (d.partial_json !== undefined) {
          const openIndex = blockIndexToToolIndex.get(bIdx) ?? toolIndexSeq++;
          blockIndexToToolIndex.set(bIdx, openIndex);
          yield chunk({ tool_calls: [{ index: openIndex, function: { arguments: d.partial_json } }] }, null);
        }
        break;
      }
      case "message_delta": {
        if (e.delta?.stop_reason) finishReason = STOP_REASON_MAP[e.delta.stop_reason] ?? "stop";
        if (typeof e.usage?.output_tokens === "number") usage.completion_tokens = e.usage.output_tokens;
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
        break;
      }
      case "message_stop": {
        if (!emittedFinish) {
          yield chunk({}, finishReason ?? "stop");
          emittedFinish = true;
        }
        break;
      }
      default:
        break; // ping, content_block_stop, others ignored
    }
  }
  if (!emittedFinish) {
    yield chunk({}, finishReason ?? "stop");
  }
  yield { id, object: "chat.completion.chunk", created: CREATED(), model: reqModel, choices: [], usage };
}

// ---------------------------------------------------------------------------

export function createAnthropicAdapter(): ProviderAdapter {
  const ENDPOINT = "/v1/messages";
  const headers = (ctx: ProviderRequestContext): Record<string, string> => {
    const h: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (ctx.apiKey) h["x-api-key"] = ctx.apiKey;
    return h;
  };

  async function post(ctx: ProviderRequestContext, body: AnthropicRequest): Promise<Response> {
    const url = `${ctx.baseUrl.replace(/\/$/, "")}${ENDPOINT}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: headers(ctx),
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      throw new ProviderError(`upstream unreachable: ${String(err)}`, 502, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(`upstream ${res.status}: ${text.slice(0, 500)}`, res.status === 401 || res.status === 403 ? 401 : 502, res.status >= 500 || res.status === 429);
    }
    return res;
  }

  return {
    async *chatStream(req: ChatCompletionRequest, ctx: ProviderRequestContext) {
      const body = toAnthropicRequest({ ...req, stream: true });
      body.stream = true;
      const res = await post(ctx, body);
      if (res.body === null) throw new ProviderError("empty upstream body", 502);
      yield* anthropicStreamToChunks(req.model, res.body);
    },

    async chatOnce(req: ChatCompletionRequest, ctx: ProviderRequestContext): Promise<ChatCompletionResponse> {
      const res = await post(ctx, toAnthropicRequest({ ...req, stream: false }));
      const raw = (await res.json()) as unknown;
      if (typeof raw !== "object" || raw === null) throw new ProviderError("unexpected anthropic response", 502);
      return fromAnthropicResponse(req.model, raw);
    },
  };
}