import type { Message } from "@foundry/protocol";

/**
 * Provider adapter layer. Canonical format in and out = OpenAI Chat
 * Completions (ADR-002). Adapters translate to/from their provider at the
 * edge; nothing else in core sees provider-specific shapes except stored raw
 * events (redacted).
 *
 * Request fields we route on are typed; unknown top-level fields pass through
 * untouched (protocol.md §2 — never reject unknown provider fields).
 */
export interface ChatCompletionRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  temperature?: number;
  max_tokens?: number;
  stop?: string | string[];
  stream_options?: { include_usage?: boolean };
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description?: string; parameters: unknown };
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function?: { name: string } };

/**
 * Streaming chunk — OpenAI `chat.completion.chunk` shape (canonical). Adapters
 * emit these; the gateway slices them into SSE (REST) or chat.delta/run.delta
 * events (WS). Terminal chunk(s) carry usage + finish_reason.
 */
export interface ChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { content?: string; reasoning_content?: string; tool_calls?: ToolCallDelta[] };
    finish_reason: string | null;
  }[];
  usage?: Usage;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Complete (non-streaming) OpenAI ChatCompletion response. */
export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: number;
    message: Message & { reasoning_content?: string };
    finish_reason: string;
  }[];
  usage: Usage;
}

export interface ProviderRequestContext {
  /** Plaintext key from the vault for this provider, if configured. */
  apiKey?: string;
  baseUrl: string;
  signal: AbortSignal;
  model: string;
}

/**
 * Streaming adapter surface. `chatStream` yields deltas; adapters that only
 * support non-streaming may yield a single full delta chunk.
 */
export interface ProviderAdapter {
  chatStream(
    req: ChatCompletionRequest,
    ctx: ProviderRequestContext,
  ): AsyncIterable<ChatChunk>;
  /** Non-streaming path; implementers may build it from one streamed call. */
  chatOnce(req: ChatCompletionRequest, ctx: ProviderRequestContext): Promise<ChatCompletionResponse>;
  /**
   * Embeddings (P3 memory). `ctx.model` is the upstream embedding model; a
   * missing method means the adapter cannot embed (memory falls back to the
   * first embedding-capable provider). Implementations must return one vector
   * per input, in input order.
   */
  embed?(texts: string[], ctx: ProviderRequestContext): Promise<number[][]>;
}

/** Adapter kinds (registry keys + db providers.kind). */
export type ProviderKind = "openai_compat" | "anthropic" | "dummy";

export interface ProviderRecord {
  id: string;
  kind: ProviderKind;
  baseUrl: string | undefined;
  apiKey?: string;
  enabled: boolean;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number = 502,
    readonly retryable = false,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export const emptyUsageStub = (prompt = 0): Usage => ({
  prompt_tokens: prompt,
  completion_tokens: 0,
  total_tokens: prompt,
});