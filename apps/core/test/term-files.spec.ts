import { describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { FoundryClient } from "@foundry/sdk-ts";
import { startServer, type TestCtx } from "./helpers.js";

/** Terminal plane (term.*) + file plane (files.*) specs on the FakeDriver —
 * the real-container versions live in docker.spec.ts (FOUNDRY_INTEGRATION).
 * Acceptance mapping: PTY open/input, resize, close; reconnect replays
 * scrollback (build-order P2). */

let ctx: TestCtx;

let client: FoundryClient;

async function boot(): Promise<{
  sock: ReturnType<FoundryClient["socket"]>;
  waitFor: (cond: () => boolean | Promise<boolean>, what?: string, timeoutMs?: number) => Promise<void>;
}> {
  ctx = await startServer();
  const waitFor = async (
    cond: () => boolean | Promise<boolean>,
    what = "condition",
    timeoutMs = 5000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await cond()) return;
      await delay(25);
    }
    throw new Error(`timeout waiting for ${what}`);
  };
  client = new FoundryClient({ baseUrl: ctx.server.baseUrl, token: ctx.server.token });
  const sock = client.socket();
  await sock.connect();
  return { sock, waitFor };
}

interface Seen {
  event: string;
  channel: string;
  payload: Record<string, unknown>;
}

function decodeTermData(payload: unknown): string {
  const p = payload as { data?: string; b64?: boolean };
  if (typeof p.data !== "string") return "";
  if (p.b64 === false) return p.data;
  return Buffer.from(p.data, "base64").toString("utf8");
}

describe("Terminal plane", () => {
  it("open → input echoes through term.data → resize → close → term.exit", async () => {
    const { sock, waitFor } = await boot();
    const open = (await sock.req("term.open", {}, "term-open-e1")) as { termId: string; envId: string; replay: string };
    expect(typeof open.termId).toBe("string");
    expect(open.termId.length).toBeGreaterThan(0);
    expect(typeof open.envId).toBe("string");
    // replay is the joined scrollback; brand-new session may still be empty
    // until the fake prompt event lands.
    expect(typeof open.replay).toBe("string");

    const seen: Seen[] = [];
    sock.on((event, channel, _seq, payload) => seen.push({ event, channel, payload: payload as Record<string, unknown> }));

    await sock.req("term.input", { termId: open.termId, data: "echo hi-from-pty\n" }, "term-in-e1");
    await waitFor(async () => {
      const joined = seen.filter((e) => e.event === "term.data").map((e) => decodeTermData(e.payload)).join("");
      return joined.includes("hi-from-pty");
    }, "pty echo");

    // resize is a no-op on the fake driver but must not error.
    await sock.req("term.resize", { termId: open.termId, cols: 100, rows: 30 }, "term-rs-e1");

    await sock.req("term.close", { termId: open.termId }, "term-close-1");
    await waitFor(() => seen.some((e) => e.event === "term.exit"), "term.exit");
    sock.close();
  });

  it("reconnect with no envId rejoins the live session and replays scrollback", async () => {
    const { sock, waitFor } = await boot();
    const first = (await sock.req("term.open", {}, "term-open-r1")) as { termId: string; replay: string };
    const seen: Seen[] = [];
    sock.on((event, channel, _seq, payload) => seen.push({ event, channel, payload: payload as Record<string, unknown> }));
    await sock.req("term.input", { termId: first.termId, data: "echo remember-me\n" }, "term-in-r1");
    await waitFor(() => seen.some((e) => e.event === "term.data" && decodeTermData(e.payload).includes("remember-me")), "pty echo");

    // A second connection from the same user rejoins → same termId + scrollback.
    const sock2 = client.socket();
    await sock2.connect();
    const second = (await sock2.req("term.open", {}, "term-open-r2")) as { termId: string; replay: string };
    expect(second.termId).toBe(first.termId);
    expect(second.replay).toContain("remember-me");
    sock.close();
    sock2.close();
  });

  it("unknown termId → not_found", async () => {
    const { sock } = await boot();
    await expect(sock.req("term.input", { termId: "term_missing", data: "x" }, "ti-missing")).rejects.toMatchObject({ code: "not_found" });
    await expect(sock.req("term.close", { termId: "term_missing" }, "tc-missing")).rejects.toMatchObject({ code: "not_found" });
    sock.close();
  });

  it("term.close requires an idem key (side-effecting method)", async () => {
    const { sock } = await boot();
    const open = (await sock.req("term.open", {}, "term-open-i1")) as { termId: string };
    await expect(sock.req("term.close", { termId: open.termId })).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("idem") });
    sock.close();
  });
});

describe("File plane", () => {
  it("write → list → read → stat → mkdir → rm roundtrip", async () => {
    const { sock } = await boot();
    await sock.req("files.write", { path: "notes/a.txt", content: "foundry fs" }, "fw-1");
    await sock.req("files.mkdir", { path: "sub/dir/here" }, "fm-1");

    const root = (await sock.req("files.list", { path: "." })) as { path: string; isDir: boolean; size: number }[];
    expect(root.some((e) => e.path === "notes" && e.isDir)).toBe(true);
    expect(root.some((e) => e.path === "sub" && e.isDir)).toBe(true);

    const read = (await sock.req("files.read", { path: "notes/a.txt" })) as { content: string; b64?: boolean };
    expect(read.content).toBe("foundry fs");

    const stat = (await sock.req("files.stat", { path: "notes/a.txt" })) as { size: number; isDir: boolean };
    expect(stat.size).toBe(10);
    expect(stat.isDir).toBe(false);

    await sock.req("files.rm", { path: "sub", recursive: true }, "fr-1");
    const after = (await sock.req("files.list", { path: "." })) as { path: string }[];
    expect(after.some((e) => e.path === "sub")).toBe(false);
    sock.close();
  });

  it("writes outside the workspace are rejected (guardrail #1)", async () => {
    const { sock } = await boot();
    await expect(sock.req("files.write", { path: "../../escape.txt", content: "no" }, "fw-esc")).rejects.toMatchObject({ code: "bad_request" });
    sock.close();
  });
});