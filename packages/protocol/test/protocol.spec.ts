import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { Value } from "@sinclair/typebox/value";
import { PROTOCOL_SCHEMAS, PROTOCOL_VERSION } from "../src/index.js";
import {
  ConnectParamsSchema,
  ConnectResultSchema,
  EventFrameSchema,
  MessageSchema,
  ResFrameSchema,
} from "../src/index.js";

const GENERATED_DIR = join(import.meta.dirname, "..", "schema", "generated");
const REQUIRED_SCHEMA_NAMES = [
  "Message",
  "Run",
  "RunStatus",
  "Model",
  "Gate",
  "FileEntry",
  "ReqFrame",
  "ResFrame",
  "EventFrame",
  "ConnectParams",
  "ConnectResult",
];

describe("protocol", () => {
  it("pins PROTOCOL_VERSION to 0", () => {
    expect(PROTOCOL_VERSION).toBe(0);
  });

  it("schemas are valid TypeBox and compile", () => {
    for (const { name, schema } of PROTOCOL_SCHEMAS) {
      expect(() => TypeCompiler.Compile(schema), `compile ${name}`).not.toThrow();
    }
  });

  it("covers the required §3 shapes and frame types", () => {
    const names = new Set(PROTOCOL_SCHEMAS.map((s) => s.name));
    for (const required of REQUIRED_SCHEMA_NAMES) {
      expect(names.has(required), `missing schema ${required}`).toBe(true);
    }
    expect(names.has("EventPayload.chat.delta")).toBe(true);
    expect(names.has("EventPayload.run.gate_resolved")).toBe(true);
  });

  it("has current emitted JSON Schema files matching the registry", () => {
    for (const name of REQUIRED_SCHEMA_NAMES) {
      const file = join(GENERATED_DIR, `${name}.json`);
      expect(
        existsSync(file),
        `run \`pnpm --filter @foundry/protocol build\` to emit ${name}.json`,
      ).toBe(true);
      const parsed = JSON.parse(readFileSync(file, "utf8")) as object;
      expect(parsed).toHaveProperty("$id", name);
    }
  });

  it("decodes protocol.md §1.2 examples", () => {
    const connectFrame = {
      type: "req",
      id: "c1",
      method: "connect",
      params: {
        protocol: 0,
        auth: { token: "fnd_s3..." },
        client: { kind: "android", version: "0.1.0" },
        resume: [{ channel: "run:abc", lastSeq: 42 }],
      },
    } as const;
    expect(Value.Check(ConnectParamsSchema, connectFrame.params)).toBe(true);

    // A mismatched protocol version passes the SCHEMA (integer) and is
    // rejected by the server's §5 version check, so the client can be told
    // which versions are supported — see ws_hub onFirstFrame (§5).
    expect(Value.Check(ConnectParamsSchema, { ...connectFrame.params, protocol: 7 })).toBe(true);

    const res = {
      type: "res",
      id: "c1",
      ok: true,
      payload: {
        sessionId: "s_01ABC",
        protocol: 0,
        features: { methods: ["chat.send"], events: ["chat.delta"] },
        snapshot: { activeRuns: ["run:abc"], unread: 2 },
      },
    } as const;
    expect(Value.Check(ConnectResultSchema, res.payload)).toBe(true);
  });

  it("error frames require a known code", () => {
    const bad = { type: "res", id: "x", ok: false, error: { code: "nope", message: "?" } };
    expect(Value.Check(ResFrameSchema, bad)).toBe(false);
    const good = {
      type: "res",
      id: "x",
      ok: false,
      error: { code: "internal", message: "boom" },
    };
    expect(Value.Check(ResFrameSchema, good)).toBe(true);
  });

  it("event frames carry channel + seq", () => {
    const frame = {
      type: "event",
      event: "chat.delta",
      channel: "chat:abc",
      seq: 7,
      payload: { runId: "r1", delta: "hi" },
    } as const;
    expect(Value.Check(EventFrameSchema, frame)).toBe(true);
    expect(
      Value.Check(EventFrameSchema, { ...frame, seq: -1 }),
    ).toBe(false);
  });

  it("Messages reject tool_calls with the wrong type tag", () => {
    const bad = {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "1", type: "tool", function: { name: "f", arguments: "{}" } }],
    };
    expect(Value.Check(MessageSchema, bad)).toBe(false);
  });
});