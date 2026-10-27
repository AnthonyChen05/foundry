import { and, eq, like, sql } from "drizzle-orm";
import type { ModelCaps } from "@foundry/protocol";
import type { FoundryDb } from "../db/open.js";
import { models, providers, vaultCiphertexts } from "../db/schema.js";
import type { Vault } from "../vault/vault.js";
import type { ProviderKind, ProviderRecord } from "./types.js";

/**
 * Provider + model catalog store. The ONLY place keys cross the vault
 * boundary: accepted once (admin upsert), encrypted immediately, decrypted
 * only when a request is routed — in-process, never sent to clients or
 * sandbox environments (hard guardrail #2).
 */
export class ProviderStore {
  constructor(
    private readonly dbx: FoundryDb,
    private readonly vault: Vault,
  ) {}

  /**
   * True upsert. With `id`: patch the row if it exists, create it with that
   * stable id if it doesn't (operator config like `POST ... {id: "ollama"}`
   * is idempotent — no duplicate prov_* rows). Without `id`: a generated id.
   */
  upsert(input: {
    id?: string;
    kind: ProviderKind;
    baseUrl?: string;
    /** Plaintext API key. Optional (dummy/local ollama need none). NEVER echoed. */
    apiKey?: string;
  }): { id: string; created: boolean } {
    if (input.id !== undefined && input.id.length > 0) {
      const existing = this.dbx.db.select().from(providers).where(eq(providers.id, input.id)).get();
      if (existing) {
        const patch: Partial<typeof providers.$inferInsert> = {};
        if (input.baseUrl !== undefined) patch.baseUrl = input.baseUrl;
        if (input.kind !== undefined) patch.kind = input.kind;
        if (input.apiKey !== undefined) patch.vaultKeyId = this.secretKeyId(input.apiKey);
        this.dbx.db.update(providers).set(patch).where(eq(providers.id, input.id)).run();
        return { id: input.id, created: false };
      }
    }
    const id = input.id ?? `prov_${Math.random().toString(36).slice(2, 10)}`;
    this.dbx.db
      .insert(providers)
      .values({
        id,
        kind: input.kind,
        baseUrl: input.baseUrl ?? null,
        vaultKeyId: input.apiKey !== undefined ? this.secretKeyId(input.apiKey) : null,
        enabled: true,
        createdAt: Date.now(),
      })
      .run();
    return { id, created: true };
  }

  /** Encrypt-and-store a secret, return the vault row id. */
  secretKeyId(plaintext: string): string {
    const blob = this.vault.encrypt(plaintext);
    const id = `vlt_${Math.random().toString(36).slice(2, 14)}`;
    this.dbx.db
      .insert(vaultCiphertexts)
      .values({
        id,
        ciphertext: blob.ciphertext,
        iv: blob.iv,
        tag: blob.tag,
        createdAt: Date.now(),
      })
      .run();
    return id;
  }

  readSecret(keyId: string | null | undefined): string | undefined {
    if (!keyId) return undefined;
    const row = this.dbx.db.select().from(vaultCiphertexts).where(eq(vaultCiphertexts.id, keyId)).get();
    if (!row) return undefined;
    return this.vault.decrypt({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag });
  }

  list(): (ProviderRecord & { vaultKeyId: string | null })[] {
    return this.dbx.db
      .select()
      .from(providers)
      .all()
      .map((p) => ({
        id: p.id,
        kind: p.kind as ProviderKind,
        baseUrl: p.baseUrl ?? undefined,
        vaultKeyId: p.vaultKeyId,
        enabled: p.enabled,
      }));
  }

  record(id: string, opts: { withKey: boolean }): ProviderRecord | undefined {
    const p = this.dbx.db.select().from(providers).where(eq(providers.id, id)).get();
    if (!p) return undefined;
    return {
      id: p.id,
      kind: p.kind as ProviderKind,
      baseUrl: p.baseUrl ?? undefined,
      apiKey: opts.withKey ? this.readSecret(p.vaultKeyId) : undefined,
      enabled: p.enabled,
    };
  }

  remove(id: string): boolean {
    // FK cascade by hand: models reference the provider, and the ciphertext
    // row is private to this provider (secretKeyId mints one per upsert).
    const row = this.dbx.db.select().from(providers).where(eq(providers.id, id)).get();
    if (!row) return false;
    this.dbx.db.delete(models).where(eq(models.providerId, id)).run();
    if (row.vaultKeyId !== null) {
      const shared = this.dbx.db
        .select({ n: sql<number>`count(*)` })
        .from(providers)
        .where(eq(providers.vaultKeyId, row.vaultKeyId))
        .get();
      if ((shared?.n ?? 0) <= 1) {
        this.dbx.db.delete(vaultCiphertexts).where(eq(vaultCiphertexts.id, row.vaultKeyId)).run();
      }
    }
    const res = this.dbx.db.delete(providers).where(eq(providers.id, id)).run();
    return (res.changes ?? 0) > 0;
  }

  // -- models catalog -------------------------------------------------------

  upsertModels(
    providerId: string,
    input: {
      id: string;
      name: string;
      context: number;
      caps: ModelCaps;
      priceIn?: number;
      priceOut?: number;
      enabled?: boolean;
    }[],
  ): void {
    for (const m of input) {
      this.dbx.db
        .insert(models)
        .values({
          id: m.id,
          providerId,
          name: m.name,
          context: m.context,
          caps: m.caps,
          priceIn: m.priceIn ?? null,
          priceOut: m.priceOut ?? null,
          enabled: m.enabled ?? true,
        })
        .onConflictDoUpdate({
          target: models.id,
          set: {
            providerId,
            name: m.name,
            context: m.context,
            caps: m.caps,
            priceIn: m.priceIn ?? null,
            priceOut: m.priceOut ?? null,
            enabled: m.enabled ?? true,
          },
        })
        .run();
    }
  }

  /**
   * The provider's model list is REPLACED (upsert + prune whatever the new
   * set doesn't carry): an explicit admin list or a fresh discovery pull is
   * the source of truth, so models dropped upstream leave the catalog.
   */
  replaceModels(
    providerId: string,
    input: {
      id: string;
      name: string;
      context: number;
      caps: ModelCaps;
      priceIn?: number;
      priceOut?: number;
      enabled?: boolean;
    }[],
  ): void {
    if (input.length > 0) this.upsertModels(providerId, input);
    const keep = new Set(input.map((m) => m.id));
    const stale = this.dbx.db
      .select({ id: models.id })
      .from(models)
      .where(eq(models.providerId, providerId))
      .all()
      .filter((m) => !keep.has(m.id));
    for (const m of stale) {
      this.dbx.db.delete(models).where(eq(models.id, m.id)).run();
    }
  }

  /** The provider's model ids (catalog maintenance paths). */
  modelIds(providerId: string): string[] {
    return this.dbx.db.select({ id: models.id }).from(models).where(eq(models.providerId, providerId)).all().map((m) => m.id);
  }

  /**
   * Resolve a wire model id (e.g. "dummy/scripted"). Bare aliases ("llama3.1")
   * resolve against the first enabled model whose id ends with "/<alias>"
   * ("bare model" rule in protocol.md §2). Enabled only.
   */
  resolveModel(wireModel: string):
    | { modelId: string; providerId: string; providerKind: ProviderKind; baseUrl?: string; vaultKeyId: string | null }
    | undefined {
    const exact = this.dbx.db
      .select()
      .from(models)
      .where(and(eq(models.id, wireModel), eq(models.enabled, true)))
      .get();
    if (exact) return this.rowToResolution(exact.id, exact.providerId);
    const bySuffix = this.dbx.db
      .select()
      .from(models)
      .where(and(like(models.id, `%/${wireModel}`), eq(models.enabled, true)))
      .limit(1)
      .get();
    if (bySuffix) return this.rowToResolution(bySuffix.id, bySuffix.providerId);
    return undefined;
  }

  private rowToResolution(modelId: string, providerId: string) {
    const p = this.dbx.db.select().from(providers).where(eq(providers.id, providerId)).get();
    if (!p || !p.enabled) return undefined;
    return {
      modelId,
      providerId: p.id,
      providerKind: p.kind as ProviderKind,
      baseUrl: p.baseUrl ?? undefined,
      vaultKeyId: p.vaultKeyId,
    };
  }

  /** First-boot seed: the dummy provider + scripted models (idempotent). */
  seedDummy(): void {
    const existing = this.list().find((p) => p.kind === "dummy");
    const { id } = this.upsert(existing ? { id: existing.id, kind: "dummy" } : { kind: "dummy" });
    this.upsertModels(id, [
      {
        id: "dummy/scripted",
        name: "Scripted (dummy)",
        context: 8192,
        caps: { vision: false, tools: true, reasoning: false, json: false },
      },
      {
        id: "dummy/scripted-slow",
        name: "Scripted slow (dummy)",
        context: 8192,
        caps: { vision: false, tools: true, reasoning: false, json: false },
      },
    ]);
  }

  listModels() {
    return this.dbx.db
      .select({
        id: models.id,
        providerId: models.providerId,
        name: models.name,
        context: models.context,
        caps: models.caps,
        priceIn: models.priceIn,
        priceOut: models.priceOut,
        enabled: models.enabled,
      })
      .from(models)
      .all();
  }
}