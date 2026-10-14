import { and, eq, inArray } from "drizzle-orm";
import { adapterFor } from "../providers/registry.js";
import type { ProviderStore } from "../providers/store.js";
import type { FoundryDb } from "../db/open.js";
import { memories as memoriesTable, settings as settingsTable } from "../db/schema.js";
import type { AgentTool, ToolContext, ToolResult } from "./tools.js";
import { ToolInputError } from "./tools.js";
import { ulid } from "../util/ulid.js";

/**
 * Long-term memory (build-order P3 task 4): text facts in `memories` +
 * 768-dim embeddings in the `memory_vec` sqlite-vec table (embedding id =
 * memories.id; created at boot when the extension loads). Embeddings come
 * from the configured provider — settings key `memory.embedding_model`
 * (`<providerId>/<model>` wire form), else the first enabled provider whose
 * adapter implements `embed`. When neither exists (or the embed fails), the
 * text row still lands and `search` degrades to substring matching so memory
 * stays usable in every config and never breaks a run.
 */

/** Wire form for memory-tool + REST results (protocol §3 Memory). */
export interface MemoryRecord {
  id: string;
  content: string;
  importance: number;
  createdAt: string;
  sourceRunId?: string;
}

/** Search hit with distance (0 = identical; cosine distance, float32 vecs). */
export interface MemoryHit extends MemoryRecord {
  distance: number;
}

/** Embedding route: sync db resolution + one async embed closure per use. */
interface EmbedRoute {
  embed(texts: string[]): Promise<number[][]>;
  label: string;
}

const EMBED_TIMEOUT_MS = 30_000;

export class MemoryService {
  constructor(
    private readonly deps: {
      dbx: FoundryDb;
      providers: ProviderStore;
      log?: (obj: object, msg: string) => void;
    },
  ) {}

  private get vec(): boolean {
    return this.deps.dbx.vecAvailable;
  }

  private settingString(key: string): string | undefined {
    const row = this.deps.dbx.db.select().from(settingsTable).where(eq(settingsTable.key, key)).get();
    const v = row?.value;
    return typeof v === "string" && v.length > 0 ? v : undefined;
  }

  /** Resolve the embedding route; undefined → substring fallback applies. */
  private resolveEmbedRoute(): EmbedRoute | undefined {
    const make = (record: NonNullable<ReturnType<ProviderStore["record"]>>, upstreamModel: string): EmbedRoute => ({
      embed: async (texts: string[]): Promise<number[][]> => {
        const adapter = adapterFor(record.kind);
        if (adapter.embed === undefined) throw new Error("provider lost its embed implementation");
        return adapter.embed(texts, {
          apiKey: record.apiKey,
          baseUrl: record.baseUrl ?? "",
          model: upstreamModel,
          signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        });
      },
      label: upstreamModel,
    });

    const setting = this.settingString("memory.embedding_model");
    if (setting !== undefined) {
      const resolved = this.deps.providers.resolveModel(setting);
      const record = resolved === undefined ? undefined : this.deps.providers.record(resolved.providerId, { withKey: true });
      if (resolved === undefined || record === undefined || adapterFor(record.kind).embed === undefined) {
        this.deps.log?.({ mod: "memory", setting }, "memory.embedding_model unusable — substring fallback");
        return undefined;
      }
      const upstreamModel = resolved.modelId.includes("/")
        ? resolved.modelId.split("/").slice(1).join("/")
        : resolved.modelId;
      return make(record, upstreamModel);
    }
    // No setting: first enabled provider whose adapter can embed.
    for (const p of this.deps.providers.list()) {
      if (!p.enabled) continue;
      if (adapterFor(p.kind).embed === undefined) continue;
      const record = this.deps.providers.record(p.id, { withKey: true });
      if (record === undefined) continue;
      // Providers pick their default embedding model by convention
      // (dummy embeds anything; Ollama operators set memory.embedding_model
      // to e.g. "ollama/nomic-embed-text" for exact control).
      return make(record, this.settingString("memory.embedding_fallback_model") ?? "default");
    }
    return undefined;
  }

  // -- sqlite-vec ops (raw, extension is loaded in db/open.ts) -------------------

  private insertVec(id: string, v: number[]): void {
    this.deps.dbx.sqlite
      .prepare("INSERT INTO memory_vec(embedding_id, embedding) VALUES (?, vec_f32(?))")
      .run(id, JSON.stringify(v));
  }

  private vecQuery(queryVec: number[], k: number): { embeddingId: string; distance: number }[] {
    const rows = this.deps.dbx.sqlite
      .prepare("SELECT embedding_id, distance FROM memory_vec WHERE embedding MATCH vec_f32(?) AND k = ?")
      .all(JSON.stringify(queryVec), k) as { embedding_id: string; distance: number }[];
    return rows.map((r) => ({ embeddingId: r.embedding_id, distance: r.distance }));
  }

  private vecDelete(id: string): void {
    this.deps.dbx.sqlite.prepare("DELETE FROM memory_vec WHERE embedding_id = ?").run(id);
  }

  // -- CRUD ---------------------------------------------------------------------

  async store(opts: {
    userId: string;
    content: string;
    importance?: number;
    sourceRunId?: string;
  }): Promise<MemoryRecord> {
    const id = `mem_${ulid()}`;
    const now = Date.now();
    this.deps.dbx.db
      .insert(memoriesTable)
      .values({
        id,
        userId: opts.userId,
        content: opts.content,
        sourceRunId: opts.sourceRunId ?? null,
        importance: opts.importance ?? 0,
        createdAt: now,
      })
      .run();
    // Vector index is best-effort — a failed embed never loses the text row.
    if (this.vec) {
      try {
        const route = this.resolveEmbedRoute();
        if (route !== undefined) {
          const [v] = await route.embed([opts.content]);
          if (v !== undefined) this.insertVec(id, v);
        }
      } catch (err) {
        this.deps.log?.({ mod: "memory", id, err: String(err) }, "memory embed failed — stored text-only");
      }
    }
    return {
      id,
      content: opts.content,
      importance: opts.importance ?? 0,
      createdAt: new Date(now).toISOString(),
      ...(opts.sourceRunId !== undefined ? { sourceRunId: opts.sourceRunId } : {}),
    };
  }

  search(opts: { userId: string; query: string; k?: number }): Promise<MemoryHit[]> {
    const k = opts.k ?? 5;
    const route = this.vec ? this.resolveEmbedRoute() : undefined;
    if (route === undefined) return Promise.resolve(this.substringSearch(opts.userId, opts.query, k));
    return route.embed([opts.query]).then(
      ([v]) => {
        if (v === undefined) return this.substringSearch(opts.userId, opts.query, k);
        const hits = this.vecQuery(v, k);
        if (hits.length === 0) return [];
        const byId = new Map(
          this.deps.dbx.db
            .select()
            .from(memoriesTable)
            .where(and(eq(memoriesTable.userId, opts.userId), inArray(memoriesTable.id, hits.map((h) => h.embeddingId))))
            .all()
            .map((r) => [r.id, r]),
        );
        const out: MemoryHit[] = [];
        for (const h of hits) {
          const row = byId.get(h.embeddingId);
          if (row !== undefined) {
            out.push({
              id: row.id,
              content: row.content,
              importance: row.importance,
              createdAt: new Date(row.createdAt).toISOString(),
              ...(row.sourceRunId !== null ? { sourceRunId: row.sourceRunId } : {}),
              distance: h.distance,
            });
          }
        }
        return out;
      },
      (err: unknown) => {
        this.deps.log?.({ mod: "memory", err: String(err) }, "memory search embed failed — substring fallback");
        return this.substringSearch(opts.userId, opts.query, k);
      },
    );
  }

  /** Degrade mode (no embedder / failed embed): case-insensitive contains. */
  private substringSearch(userId: string, query: string, k: number): MemoryHit[] {
    const rows = this.deps.dbx.db.select().from(memoriesTable).where(eq(memoriesTable.userId, userId)).all();
    const q = query.toLowerCase();
    return rows
      .filter((r) => r.content.toLowerCase().includes(q))
      .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)
      .slice(0, k)
      .map((r) => ({
        id: r.id,
        content: r.content,
        importance: r.importance,
        createdAt: new Date(r.createdAt).toISOString(),
        ...(r.sourceRunId !== null ? { sourceRunId: r.sourceRunId } : {}),
        distance: 1,
      }));
  }

  /** Remove one memory (scoped: only the owner's own rows). */
  delete(opts: { userId: string; id: string }): boolean {
    const res = this.deps.dbx.db
      .delete(memoriesTable)
      .where(and(eq(memoriesTable.id, opts.id), eq(memoriesTable.userId, opts.userId)))
      .run();
    const gone = (res.changes ?? 0) > 0;
    if (gone && this.vec) {
      try {
        this.vecDelete(opts.id);
      } catch (err) {
        this.deps.log?.({ mod: "memory", id: opts.id, err: String(err) }, "memory_vec delete failed");
      }
    }
    return gone;
  }

  list(userId: string, limit = 200): MemoryRecord[] {
    type Row = typeof memoriesTable.$inferSelect;
    return this.deps.dbx.db
      .select()
      .from(memoriesTable)
      .where(eq(memoriesTable.userId, userId))
      .all()
      .sort((a: Row, b: Row) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((r: Row) => ({
        id: r.id,
        content: r.content,
        importance: r.importance,
        createdAt: new Date(r.createdAt).toISOString(),
        ...(r.sourceRunId !== null ? { sourceRunId: r.sourceRunId } : {}),
      }));
  }

  /**
   * Retrieval for system-prompt injection (top-k): returns the formatted
   * block or undefined (no hits → prompt untouched).
   */
  async recallForPrompt(userId: string, query: string, k = 3): Promise<string | undefined> {
    const hits = await this.search({ userId, query, k });
    if (hits.length === 0) return undefined;
    return [
      "### Long-term memories (most relevant first)",
      ...hits.map((h) => `- ${h.content}${h.importance > 0 ? ` (importance ${h.importance})` : ""}`),
    ].join("\n");
  }
}

// -- agent tool ------------------------------------------------------------------

/**
 * The memories CRUD surface as an agent tool (build-order P3 task 4). Needs
 * ToolContext extras — runtime sets userId/runId on every call's context.
 */
export function buildMemoryTool(memory: MemoryService): AgentTool {
  return {
    def: {
      type: "function",
      function: {
        name: "memory",
        description:
          "Persist, search, or remove long-term memory facts (recalled automatically in future chats). " +
          "Use store for durable facts about the user or their setup, search to recall, delete to forget.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["store", "search", "delete"] },
            content: { type: "string", description: "store: the fact to remember." },
            query: { type: "string", description: "search: what to look for." },
            id: { type: "string", description: "delete: memory id (from search results)." },
            importance: { type: "number", description: "store: 0..1 salience (default 0)." },
          },
          required: ["action"],
        },
      },
    },
    execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      const action = args["action"];
      const userId = ctx.userId;
      if (typeof userId !== "string" || userId.length === 0) {
        throw new ToolInputError("memory tool requires the run's user context");
      }
      if (action === "store") {
        const content = typeof args["content"] === "string" ? args["content"].trim() : "";
        if (content.length === 0) throw new ToolInputError('memory store requires non-empty "content"');
        const importance = typeof args["importance"] === "number" ? args["importance"] : 0;
        const rec = await memory.store({ userId, content, importance, ...(ctx.runId !== undefined ? { sourceRunId: ctx.runId } : {}) });
        return { content: JSON.stringify(rec) };
      }
      if (action === "search") {
        const query = typeof args["query"] === "string" ? args["query"].trim() : "";
        if (query.length === 0) throw new ToolInputError('memory search requires non-empty "query"');
        const hits = await memory.search({ userId, query, ...(typeof args["k"] === "number" ? { k: args["k"] } : {}) });
        return {
          content: hits.length === 0 ? "no memories matched" : JSON.stringify(hits.map(({ content, distance, importance, id, createdAt }) => ({ id, content, distance, importance, createdAt }))),
        };
      }
      if (action === "delete") {
        const id = typeof args["id"] === "string" ? args["id"] : "";
        if (id.length === 0) throw new ToolInputError('memory delete requires "id"');
        const ok = memory.delete({ userId, id });
        return { content: ok ? `deleted ${id}` : `no memory ${id}`, isError: ok ? undefined : true };
      }
      throw new ToolInputError(`memory action must be store|search|delete, got ${String(action)}`);
    },
  };
}