import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
import type { BlobStore } from "../storage/blobs.js";
import { ulid } from "../util/ulid.js";

/**
 * Workspace snapshots: tar.gz of the host workspace dir → content-addressed
 * blob. Deviation from data-model.md's "tar+zstd": gzip (zero native deps —
 * ADR-007 spirit); document in the changelog when the zstd driver arrives.
 * Keep-last-20 pruning + blob refcounting live in BlobStore.snapshot.
 */
export async function snapshotWorkspace(opts: {
  blobs: BlobStore;
  workspaceId: string;
  workspaceDir: string;
  envId: string;
  note?: string;
}): Promise<string> {
  const tarPath = join(tmpdir(), `fnd-snap-${ulid()}.tar.gz`);
  // tar v7: file + gzip options write an archive to disk; "portable" keeps
  // relative POSIX paths and skips platform junk (owner metadata, DS_Store).
  await create({ file: tarPath, gzip: true, portable: true, C: opts.workspaceDir }, ["."]);
  try {
    const blobId = await opts.blobs.putFile(tarPath, "application/gzip");
    opts.blobs.snapshot(opts.workspaceId, opts.envId, blobId, opts.note);
    return blobId;
  } finally {
    rmSync(tarPath, { force: true });
  }
}