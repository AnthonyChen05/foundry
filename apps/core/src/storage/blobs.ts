import { createHash } from "node:crypto";
import { mkdirSync, copyFileSync, statSync, existsSync, unlinkSync, readFileSync, writeFileSync, createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { FoundryDb } from "../db/open.js";
import { blobs, snapshots } from "../db/schema.js";
import { ulid } from "../util/ulid.js";

/**
 * Content-addressed blob store (data-model.md): sha256 →
 * $FOUNDRY_DATA_DIR/blobs/<aa>/<hex>; DB rows carry size/mime/refcount.
 * Snapshots (tar.gz of a workspace) and file attachments live here.
 */

export class BlobStore {
  private readonly root: string;

  constructor(
    private readonly dbx: FoundryDb,
    dataDir: string,
  ) {
    this.root = resolve(join(dataDir, "blobs"));
    mkdirSync(this.root, { recursive: true });
  }

  private pathFor(id: string): string {
    return join(this.root, id.slice(0, 2), id);
  }

  /** Move bytes into the store (dedupe by hash); returns the blob id. */
  async put(data: Buffer, mime: string): Promise<string> {
    const id = createHash("sha256").update(data).digest("hex");
    const path = this.pathFor(id);
    if (!existsSync(path)) {
      mkdirSync(join(this.root, id.slice(0, 2)), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, data);
      copyFileSync(tmp, path);
      unlinkSync(tmp);
    }
    const existing = this.dbx.db.select().from(blobs).where(eq(blobs.id, id)).get();
    if (existing !== undefined) return id;
    this.dbx.db.insert(blobs).values({ id, size: data.length, mime, path, refcount: 0, createdAt: Date.now() }).run();
    return id;
  }

  /** Copy an existing file in (streams to disk — files may be large). */
  async putFile(srcPath: string, mime: string): Promise<string> {
    const size = statSync(srcPath).size;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(srcPath)) hash.update(chunk as Buffer);
    const id = hash.digest("hex");
    const path = this.pathFor(id);
    if (!existsSync(path)) {
      mkdirSync(join(this.root, id.slice(0, 2)), { recursive: true });
      copyFileSync(srcPath, path);
    }
    const existing = this.dbx.db.select().from(blobs).where(eq(blobs.id, id)).get();
    if (existing !== undefined) return id;
    this.dbx.db.insert(blobs).values({ id, size, mime, path, refcount: 0, createdAt: Date.now() }).run();
    return id;
  }

  path(id: string): string {
    return this.pathFor(id);
  }

  read(id: string): Buffer {
    return readFileSync(this.pathFor(id));
  }

  /** Record a workspace snapshot referencing a blob; prunes to keep 20. */
  snapshot(workspaceId: string, envId: string, blobId: string, note?: string): void {
    this.dbx.db.update(blobs).set({ refcount: sql`${blobs.refcount} + 1` }).where(eq(blobs.id, blobId)).run();
    this.dbx.db.insert(snapshots).values({ id: `snp_${ulid()}`, envId, workspaceId, blobId, note: note ?? null, createdAt: Date.now() }).run();
    const keep = 20;
    const rows = this.dbx.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.workspaceId, workspaceId))
      .all()
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const old of rows.slice(keep)) {
      const blob = this.dbx.db.select().from(blobs).where(eq(blobs.id, old.blobId)).get();
      if (blob !== undefined && blob.refcount <= 1) {
        try {
          unlinkSync(blob.path);
        } catch {
          // already gone
        }
        this.dbx.db.delete(blobs).where(eq(blobs.id, blob.id)).run();
      }
      this.dbx.db.delete(snapshots).where(eq(snapshots.id, old.id)).run();
    }
  }
}