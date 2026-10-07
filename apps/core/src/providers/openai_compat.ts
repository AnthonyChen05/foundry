import {
  type ChatChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ProviderAdapter,
  type ProviderRequestContext,
  ProviderError,
  type Usage,
} from "./types.js";

/**
 * openai_compat adapter: covers Ollama, LM Studio, vLLM, OpenRouter, Groq,
 * OpenAI — anything speaking /v1/chat/completions. Request is forwarded as-is
 * plus `stream_options.include_usage` when streaming (so usage arrives); the
 * response is parsed and re-emitted as canonical chunks (metering + relay).
 * Unknown request/response fields pass through untouched.
 */

export const OPENAI_ENDPOINT = "/v1/chat/completions";

/** Parse an SSE byte stream of `data: {...}` events into decoded strings. */
export async function* parseSseLines(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const bytes of body) {
    buf += decoder.decode(bytes, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload.length > 0) yield payload;
    }
  }
  if ((buf = buf.trim()).startsWith("data:")) {
    const payload = buf.slice(5).trim();
    if (payload.length > 0) yield payload;
  }
}

export function headersWithKey(ctx: ProviderRequestContext): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ctx.apiKey) headers["authorization"] = `Bearer ${ctx.apiKey}`;
  return headers;
}

export function extractUsage(obj: unknown): Usage | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const u = (obj as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } }).usage;
  if (typeof u?.prompt_tokens !== "number" || typeof u?.completion_tokens !== "number") return undefined;
  return {
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : u.prompt_tokens + u.completion_tokens,
  };
}

export async function requestUpstream(
  ctx: ProviderRequestContext,
  body: ChatCompletionRequest,
): Promise<{ url: string; res: Response }> {
  const base = ctx.baseUrl.replace(/\/$/, "");
  const url = `${base}${OPENAI_ENDPOINT}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: headersWithKey(ctx),
      body: JSON.stringify({ ...body, stream: body.stream === true }),
      signal: ctx.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw new ProviderError(`upstream unreachable: ${String(err)}`, 502, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(`upstream ${res.status}: ${text.slice(0, 500)}`, res.status === 401 || res.status === 403 ? 401 : 502, res.status >= 500 || res.status === 429, { providerStatus: res.status });
  }
  return { url, res };
}

export function createOpenAiCompatAdapter(): ProviderAdapter {
  return {
    async *chatStream(req: ChatCompletionRequest, ctx: ProviderRequestContext) {
      const body: ChatCompletionRequest = { ...req, stream: true };
      if (body.messages.length === 0) throw new ProviderError("messages required", 400);
      // ask upstream for usage so metering works even when client didn't ask
      const includeUsage = body.stream_options?.include_usage === true;
      if (!includeUsage) body.stream_options = { ...body.stream_options, include_usage: true };

      const { url, res } = await requestUpstream(ctx, body);
      if (res.body === null) throw new ProviderError("empty upstream body", 502);

      for await (const payload of parseSseLines(res.body)) {
        if (payload === "[DONE]") break;
        let chunk: unknown;
        try {
          chunk = JSON.parse(payload);
        } catch {
          throw new ProviderError(`malformed SSE payload from ${url}`, 502);
        }
        if (typeof chunk !== "object" || chunk === null) continue;
        const typed = chunk as { object?: string };
        if (typed.object !== "chat.completion.chunk") continue; // ignore non-chunk events
        yield chunk as ChatChunk;
      }
    },

    async chatOnce(req: ChatCompletionRequest, ctx: ProviderRequestContext): Promise<ChatCompletionResponse> {
      const { url, res } = await requestUpstream(ctx, { ...req, stream: false });
      const json = (await res.json()) as unknown;
      if (
        typeof json !== "object" ||
        json === null ||
        (json as { object?: string }).object !== "chat.completion" ||
        !Array.isArray((json as { choices?: unknown[] }).choices)
      ) {
        throw new ProviderError(`unexpected response shape from ${url}`, 502);
      }
      return json as ChatCompletionResponse;
    },
  };
}