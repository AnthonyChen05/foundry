import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FoundryDb } from "../db/open.js";
import { hooks as hooksTable, settings as settingsTable, vaultCiphertexts as vaultTable } from "../db/schema.js";
import type { Vault } from "../vault/vault.js";
import { ulid } from "../util/ulid.js";
import type { ChatService } from "./chat.js";
import type { NotifyService } from "./notify.js";
import type { AgentRunner } from "../agent/runtime.js";
import type { ProviderStore } from "../providers/store.js";

/**
 * Webhooks (build-order P3 task 3): `POST /hook/:id` — a PUBLIC route that
 * only HMAC-SHA256 vouches for. The signature covers the RAW request body:
 * `X-Foundry-Signature: sha256=<hex>` (GitHub-style, timing-safe compare).
 * Secrets mint server-side, are shown to the operator exactly once (like
 * provider keys), and live vault-encrypted — HMAC verification needs the
 * secret itself, so unlike api keys these are stored recoverable, never as a
 * digest.
 *
 * Target v0 = `chat`: payload `content` (+ optional title/model) becomes an
 * agent run on a fresh conversation; the HTTP response is immediate — the run
 * streams over WS with the others.
 */

export interface HookRecord {
  id: string;
  name: string;
  target: "chat";
  model?: string | null;
  createdAt: string;
}

export interface HookCreateResult {
  hook: HookRecord;
  /** Plaintext secret — shown exactly once, never echoed again. */
  secret: string;
  url: string;
}

type Emit = (event: string, channel: string, payload: unknown) => void;

export class HookService {
  constructor(
    private readonly deps: {
      dbx: FoundryDb;
      vault: Vault;
      chat: ChatService;
      providers: ProviderStore;
      agents: AgentRunner;
      emit: Emit;
      notify?: NotifyService;
      log?: (obj: object, msg: string) => void;
    },
  ) {}

  // -- admin CRUD ----------------------------------------------------------------

  create(userId: string, name: string, model?: string | null, target: "chat" = "chat"): HookCreateResult {
    const secret = `fndwhsec_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    const blob = this.deps.vault.encrypt(secret);
    const vaultId = `vlt_${Math.random().toString(36).slice(2, 14)}`;
    const id = `hook_${ulid()}`;
    const now = Date.now();
    this.deps.dbx.db.transaction(() => {
      this.deps.dbx.db
        .insert(vaultTable)
        .values({ id: vaultId, ciphertext: blob.ciphertext, iv: blob.iv, tag: blob.tag, createdAt: now })
        .run();
      this.deps.dbx.db
        .insert(hooksTable)
        .values({ id, userId, name, secretVaultId: vaultId, target, model: model ?? null, createdAt: now })
        .run();
    });
    return {
      hook: {
        id,
        name,
        target,
        ...(model !== undefined && model !== null ? { model } : {}),
        createdAt: new Date(now).toISOString(),
      },
      secret,
      url: `/hook/${id}`,
    };
  }

  list(userId: string): HookRecord[] {
    type Row = typeof hooksTable.$inferSelect;
    return this.deps.dbx.db
      .select()
      .from(hooksTable)
      .where(eq(hooksTable.userId, userId))
      .all()
      .sort((a: Row, b: Row) => b.createdAt - a.createdAt)
      .map((r: Row) => ({
        id: r.id,
        name: r.name,
        target: "chat" as const,
        ...(r.model !== null ? { model: r.model } : {}),
        createdAt: new Date(r.createdAt).toISOString(),
      }));
  }

  remove(userId: string, id: string): boolean {
    const row = this.deps.dbx.db.select().from(hooksTable).where(eq(hooksTable.id, id)).get();
    if (row === undefined || row.userId !== userId) return false;
    this.deps.dbx.db.delete(hooksTable).where(eq(hooksTable.id, id)).run();
    return true;
  }

  // -- trigger plane ---------------------------------------------------------------

  /**
   * Verify + fire in one step. Returns undefined when the hook is unknown
   * (→ 404); {ok:false, reason} → 401; else the fire result.
   */
  trigger(hookId: string, rawBody: Buffer, signatureHeader: string | undefined, payload: { content: string; title?: string; model?: string | null }): { ok: true; runId: string; conversationId: string } | { ok: false; reason: string } | undefined {
    const row = this.deps.dbx.db.select().from(hooksTable).where(eq(hooksTable.id, hookId)).get();
    if (row === undefined) return undefined;
    const check = this.verifyRow(row, rawBody, signatureHeader);
    if (!check.ok) return { ok: false, reason: check.reason };
    const res = this.fire(check.hook, payload.content, payload.title, payload.model);
    return { ok: true, runId: res.runId, conversationId: res.conversationId };
  }

  fire(hook: { id: string; userId: string; name: string; model: string | null }, content: string, title: string | undefined, modelOverride: string | null | undefined): { runId: string; conversationId: string } {
    const wireModel = this.modelFor(modelOverride ?? hook.model);
    const convTitle = title !== undefined && title.length > 0 ? title : `Webhook: ${hook.name}`;
    const conv = this.deps.chat.createConversation(hook.userId, convTitle, wireModel);
    this.deps.chat.appendMessage(conv.id, { role: "user", content });
    const runId = this.deps.chat.createRun({ userId: hook.userId, conversationId: conv.id, model: wireModel, trigger: "webhook", agent: true });
    this.deps.notify?.push(`Webhook fired: ${hook.name}`, content.slice(0, 200), runId);
    this.deps.log?.({ mod: "hooks", hook: hook.id, runId }, "webhook run started");
    this.deps.emit("run.status", `run:${runId}`, { runId, status: "running" });
    void this.deps.agents
      .startRun({
        runId,
        userId: hook.userId,
        wireModel,
        conversationId: conv.id,
        emit: this.deps.emit,
        signal: new AbortController().signal,
      })
      .catch((err: unknown) => {
        this.deps.log?.({ mod: "hooks", hook: hook.id, runId, err: String(err) }, "webhook run failed");
      });
    return { runId, conversationId: conv.id };
  }

  private modelFor(model: string | null | undefined): string {
    if (model !== undefined && model !== null && model.length > 0) {
      try {
        this.deps.chat.route(model);
        return model;
      } catch {
        this.deps.log?.({ mod: "hooks", model }, "hook model does not resolve — defaulting");
      }
    }
    const dmRow = this.deps.dbx.db.select().from(settingsTable).where(eq(settingsTable.key, "default_model")).get();
    const dm = typeof dmRow?.value === "string" && dmRow.value.length > 0 ? dmRow.value : undefined;
    if (dm !== undefined) {
      try {
        this.deps.chat.route(dm);
        return dm;
      } catch {
        // fall through
      }
    }
    const first = this.deps.providers.listModels().find((m) => m.enabled);
    if (first === undefined) throw new Error("no enabled model to run a webhook");
    return first.id;
  }

  // -- HMAC verification --------------------------------------------------------------

  /**
   * Timing-safe verification of the raw body against the vaulted secret.
   * Throws on unknown hook (→ 404 at the route); returns false on any
   * signature problem (→ 401).
   */
  verify(hookId: string, rawBody: Buffer, signatureHeader: string | undefined): { hook: { id: string; userId: string; name: string; model: string | null }; ok: boolean; reason: string } {
    const row = this.deps.dbx.db.select().from(hooksTable).where(eq(hooksTable.id, hookId)).get();
    if (row === undefined) throw new Error(`unknown hook: ${hookId}`);
    return this.verifyRow(row, rawBody, signatureHeader);
  }

  /** Row already loaded (trigger path) — same checks, no re-select. */
  private verifyRow(row: typeof hooksTable.$inferSelect, rawBody: Buffer, signatureHeader: string | undefined): { hook: { id: string; userId: string; name: string; model: string | null }; ok: boolean; reason: string } {
    if (row.secretVaultId === null || signatureHeader === undefined) {
      return { hook: this.rowWire(row), ok: false, reason: "missing signature" };
    }
    const blobRow = this.deps.dbx.db.select().from(vaultTable).where(eq(vaultTable.id, row.secretVaultId)).get();
    if (blobRow === undefined) return { hook: this.rowWire(row), ok: false, reason: "hook secret missing" };
    let secret: string;
    try {
      secret = this.deps.vault.decrypt({ ciphertext: blobRow.ciphertext, iv: blobRow.iv, tag: blobRow.tag });
    } catch (err) {
      this.deps.log?.({ mod: "hooks", hook: row.id, err: String(err) }, "hook secret decrypt failed");
      return { hook: this.rowWire(row), ok: false, reason: "hook secret unreadable" };
    }
    const supplied = /^sha256=([0-9a-fA-F]{64})$/.exec(signatureHeader)?.[1];
    if (supplied === undefined) return { hook: this.rowWire(row), ok: false, reason: "bad signature format" };
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const ok = timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(supplied, "utf8"));
    return { hook: this.rowWire(row), ok, reason: ok ? "verified" : "signature mismatch" };
  }

  private rowWire(r: typeof hooksTable.$inferSelect): { id: string; userId: string; name: string; model: string | null } {
    return { id: r.id, userId: r.userId, name: r.name, model: r.model };
  }
}