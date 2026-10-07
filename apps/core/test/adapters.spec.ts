import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { adapterFor } from "../src/providers/registry.js";
import {
  anthropicStreamToChunks,
  fromAnthropicResponse,
  toAnthropicRequest,
} from "../src/providers/anthropic.js";
import { ChatService } from "../src/gateway/chat.js";
import { ProviderError } from "../src/providers/types.js";
import type { ChatChunk, ProviderRequestContext } from "../src/providers/types.js";

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

function ctx(baseUrl: string): ProviderRequestContext {
  return { baseUrl, signal: new AbortController().signal, model: "m" };
}

// -- dummy ---------------------------------------------------------------------

describe("dummy adapter", () => {
  it("streams a deterministic echo without tools", async () => {
    const a = adapterFor("dummy");
    const req = { model: "scripted", stream: true, messages: [{ role: "user" as const, content: "hi there" }] };
    const r1 = await collect(a.chatStream(req, ctx("http://unused")));
    const r2 = await collect(a.chatStream(req, ctx("http://unused")));
    const asm1 = ChatService.assemble(r1);
    const asm2 = ChatService.assemble(r2);
    expect(asm1.message.content).toBe('You said: "hi there"');
    expect(asm1.finishReason).toBe("stop");
    // determinism: identical bytes twice
    expect(r1).toEqual(r2);
    expect(asm1.usage).toEqual(asm2.usage);
    // final usage-only chunk carries the deterministic estimate
    expect(r1.at(-1)?.usage?.total_tokens).toBeGreaterThan(0);
  });

  it("scripted tool call on first tool", async () => {
    const a = adapterFor("dummy");
    const req = {
      model: "scripted",
      stream: true,
      messages: [{ role: "user" as const, content: "x" }],
      tools: [{ type: "function" as const, function: { name: "get_weather", parameters: {} } }],
    };
    const chunks = await collect(a.chatStream(req, ctx("http://unused")));
    const asm = ChatService.assemble(chunks);
    expect(asm.finishReason).toBe("tool_calls");
    expect(asm.message.tool_calls?.[0]).toEqual({
      id: "call_dummy_01",
      type: "function",
      function: { name: "get_weather", arguments: '{"action":"default"}' },
    });
  });
});

// -- openai_compat against a local fixture server --------------------------------

let fixtureServer: Server | undefined;
let fixturePort = 0;
let lastFixtureBody: Record<string, unknown> | undefined;

async function withFixture(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  fixtureServer?.close();
  fixtureServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    let data = "";
    req.on("data", (c: Buffer) => {
      data += c.toString("utf8");
    });
    req.on("end", () => {
      lastFixtureBody = JSON.parse(data || "{}") as Record<string, unknown>;
      if (req.url?.includes("authfail")) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid key" } }));
        return;
      }
      if (req.url?.includes("plain")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "resp1",
          object: "chat.completion",
          created: 1,
          model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: "plain ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const sse = (o: object): string => `data: ${JSON.stringify(o)}\n\n`;
      const chunk = (delta: object, finish: string | null): object => ({
        id: "c1", object: "chat.completion.chunk", created: 1, model: "m",
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      res.write(sse(chunk({ content: "Hel" }, null)));
      res.write(sse(chunk({ content: "lo" }, null)));
      res.write(sse(chunk({}, "stop")));
      res.write(sse({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const server = fixtureServer; // non-null: assigned above
  await new Promise<void>((r) => {
    server.listen(0, "127.0.0.1", () => r());
  });
  const addr = fixtureServer.address();
  fixturePort = typeof addr === "object" && addr !== null ? addr.port : 0;
  await fn(`http://127.0.0.1:${fixturePort}`);
}

afterAll(async () => {
  fixtureServer?.close();
});

describe("openai_compat adapter", () => {
  it("re-emits streamed chunks and passes usage through", async () => {
    await withFixture(async (baseUrl) => {
      const a = adapterFor("openai_compat");
      const chunks = await collect(a.chatStream(
        { model: "llama", stream: true, messages: [{ role: "user" as const, content: "hi" }] },
        ctx(baseUrl),
      ));
      const texts = chunks.flatMap((c) => c.choices.flatMap((ch) => (typeof ch.delta.content === "string" ? [ch.delta.content] : [])));
      expect(texts).toEqual(["Hel", "lo"]);
      const finish = chunks.find((c) => c.choices[0]?.finish_reason === "stop");
      expect(finish).toBeDefined();
      const usageChunk = chunks.at(-1);
      expect(usageChunk?.usage).toEqual({ prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
      expect(chunks[chunks.length - 1]?.choices.length === 0).toBe(true);
      // ChatService can assemble the canonical message from them
      const asm = ChatService.assemble(chunks);
      expect(asm.message.content).toBe("Hello");
      expect(asm.usage?.total_tokens).toBe(6);
    });
  });

  it("forces stream:true + include_usage upstream and forwards passthrough fields", async () => {
    await withFixture(async (baseUrl) => {
      const a = adapterFor("openai_compat");
      await collect(a.chatStream(
        {
          model: "llama",
          stream: true,
          messages: [{ role: "user" as const, content: "hi" }],
        },
        { ...ctx(baseUrl), model: "llama" } as ProviderRequestContext,
      ));
      expect(lastFixtureBody?.["stream"]).toBe(true);
      expect((lastFixtureBody?.["stream_options"] as { include_usage?: boolean }).include_usage).toBe(true);
    });
    // passthrough: unknown top-level fields reach the provider untouched
    await withFixture(async (baseUrl) => {
      const a = adapterFor("openai_compat");
      await collect(a.chatStream(
        {
          ...({ frequency_penalty: 0.5, user: "anthony", metadata: { a: 1 } } as Record<string, unknown>),
          model: "llama",
          stream: true,
          messages: [{ role: "user" as const, content: "hi" }],
        },
        ctx(baseUrl),
      ) as AsyncIterable<ChatChunk>);
      expect(lastFixtureBody?.["frequency_penalty"]).toBe(0.5);
      expect(lastFixtureBody?.["user"]).toBe("anthony");
      expect(lastFixtureBody?.["metadata"]).toEqual({ a: 1 });
    });
  });

  it("maps 401 upstream to ProviderError 401", async () => {
    await withFixture(async (baseUrl) => {
      const a = adapterFor("openai_compat");
      const url = `${baseUrl}/authfail`;
      await expect(collect(a.chatStream(
        { model: "llama", stream: true, messages: [{ role: "user" as const, content: "hi" }] },
        ctx(url),
      ))).rejects.toMatchObject({ name: "ProviderError", status: 401 });
    });
  });

  it("chatOnce returns the plain JSON completion", async () => {
    await withFixture(async (baseUrl) => {
      const a = adapterFor("openai_compat");
      const res = await a.chatOnce(
        { model: "llama", stream: false, messages: [{ role: "user" as const, content: "hi" }] },
        ctx(`${baseUrl}/plain`),
      );
      expect(res.object).toBe("chat.completion");
      expect(res.choices[0]?.message.content).toBe("plain ok");
      expect(res.usage.total_tokens).toBe(5);
    });
  });

  it("maps unreachable upstream to retryable ProviderError", async () => {
    const a = adapterFor("openai_compat");
    await expect(collect(a.chatStream(
      { model: "llama", stream: true, messages: [{ role: "user" as const, content: "hi" }] },
      ctx("http://127.0.0.1:1"),
    ))).rejects.toMatchObject({ name: "ProviderError", retryable: true });
  });
});

// -- anthropic shim ---------------------------------------------------------------

describe("anthropic translation", () => {
  it("extracts system, maps tools + tool_choice, strips model prefix", () => {
    const out = toAnthropicRequest({
      model: "anthropic/claude-sonnet-5",
      stream: true,
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "what" },
        { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: '{"x":1}' } }] },
        { role: "tool", tool_call_id: "t1", content: "42" },
        { role: "user", content: "ok" },
      ],
      tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }],
      tool_choice: "required",
      max_tokens: 256,
    });
    expect(out.model).toBe("claude-sonnet-5");
    expect(out.system).toBe("be terse");
    expect(out.max_tokens).toBe(256);
    expect(out.stream).toBe(true);
    expect(out.tools).toEqual([{ name: "f", description: "d", input_schema: { type: "object" } }]);
    expect(out.tool_choice).toEqual({ type: "any" });
    const roles = out.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user", "user"]);
    const assistantBlocks = out.messages[1]?.content as { type: string; id?: string; name?: string; input?: unknown }[];
    expect(assistantBlocks).toEqual([{ type: "tool_use", id: "t1", name: "f", input: { x: 1 } }]);
    const toolResult = out.messages[2]?.content as { type: string; tool_use_id: string; content: { type: string; text: string }[] }[];
    expect(toolResult[0]?.tool_use_id).toBe("t1");
    expect(toolResult[0]?.content[0]?.text).toBe("42");
  });

  it("maps responses: thinking → reasoning_content, tool_use → tool_calls, stop reasons", () => {
    const res = fromAnthropicResponse("anthropic/claude-sonnet-5", {
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "answer" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    expect(res.choices[0]?.message.content).toBe("answer");
    expect(res.choices[0]?.message.reasoning_content).toBe("hmm");
    expect(res.choices[0]?.finish_reason).toBe("stop");
    expect(res.usage).toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
    expect(res.model).toBe("anthropic/claude-sonnet-5");

    const res2 = fromAnthropicResponse("m", {
      content: [{ type: "tool_use", id: "tu1", name: "sh", input: { cmd: "ls" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(res2.choices[0]?.finish_reason).toBe("tool_calls");
    expect(res2.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("sh");
    expect(JSON.parse(res2.choices[0]?.message.tool_calls?.[0]?.function.arguments ?? "{}")).toEqual({ cmd: "ls" });
    expect(res2.choices[0]?.message.reasoning_content).toBeUndefined();
  });

  it("translates the event stream to OpenAI chunks", async () => {
    async function* body(): AsyncGenerator<Uint8Array> {
      for (const line of [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":9}}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"text":"He"}}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu9","name":"go"}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"partial_json":"{\\"a\\""}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"partial_json":":1}"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":6}}',
        'data: {"type":"message_stop"}',
      ]) {
        yield Buffer.from(`${line}\n\n`, "utf8");
      }
    }
    const chunks = await collect(anthropicStreamToChunks("anthropic/claude-5", body()));
    const asm = ChatService.assemble(chunks);
    expect(asm.message.content).toBe("He");
    expect(asm.finishReason).toBe("tool_calls");
    expect(asm.message.tool_calls?.[0]?.function.name).toBe("go");
    expect(asm.message.tool_calls?.[0]?.function.arguments).toBe('{"a":1}');
    expect(asm.usage).toEqual({ prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 });
  });

  it("surfaces upstream errors as ProviderError", async () => {
    async function* body(): AsyncGenerator<Uint8Array> {
      yield Buffer.from('data: {"type":"error","error":{"type":"overloaded_error","message":"slow down"}}\n\n', "utf8");
    }
    await expect(collect(anthropicStreamToChunks("m", body()))).rejects.toBeInstanceOf(ProviderError);
  });
});