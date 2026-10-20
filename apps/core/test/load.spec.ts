import { describe, expect, it } from "vitest";
import { startServer, type TestCtx } from "./helpers.js";

/**
 * Load test (P5, build-order): 10 concurrent SSE chat-completions streams.
 * The slow dummy model streams at ~120ms/chunk, so 10 SERIAL completions
 * would take ~20s+ — running 10 at once proves non-blocking concurrency
 * when the whole batch finishes far under that.
 */

const N = 10;

describe("load: 10 concurrent streams", () => {
  it("streams 10 completions concurrently, every one intact (and actually parallel)", async () => {
    const ctx: TestCtx = await startServer();
    const post = async (i: number): Promise<{ status: number; content: string }> => {
      const r = await fetch(`${ctx.server.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.server.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "dummy/scripted-slow",
          stream: true,
          messages: [{ role: "user", content: `load ${i}` }],
        }),
      });
      const text = await r.text();
      const chunks = text
        .split("\n")
        .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
        .map((l) => JSON.parse(l.slice(6)) as { choices: { delta?: { content?: string } }[] });
      const content = chunks
        .flatMap((ch) => ch.choices.map((c) => c.delta?.content ?? ""))
        .join("");
      return { status: r.status, content };
    };

    const started = Date.now();
    const results = await Promise.all(Array.from({ length: N }, (_, i) => post(i)));
    const elapsed = Date.now() - started;

    for (let i = 0; i < N; i++) {
      expect(results[i]?.status).toBe(200);
      expect(results[i]?.content).toBe(`You said: "load ${i}"`);
    }
    // ~2.3s per stream alone ⇒ serial would be ~23s. Anything below 10s
    // means the fastify/provider pipeline genuinely overlapped them.
    expect(elapsed).toBeLessThan(10_000);
    await ctx.cleanup();
  }, 30_000);
});