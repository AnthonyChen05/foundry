import { mkdirSync, rmSync } from "node:fs";
import { x } from "tar";

/**
 * Workspace restore (ADR-015 push-to-cloud): the missing inverse of
 * snapshot.ts. The archive is a POSIX tar authored INSIDE a container (or by
 * the test harness's Node tar) — workspace-relative, safe paths; symlinks are
 * dropped (workspaces never need them and they are an escape hatch). The
 * target dir is wiped first so a re-push restores a deterministic state.
 */
export async function restoreWorkspaceTar(opts: { blobPath: string; workspaceDir: string }): Promise<{ files: number }> {
  rmSync(opts.workspaceDir, { recursive: true, force: true });
  mkdirSync(opts.workspaceDir, { recursive: true });
  let files = 0;
  await x({
    file: opts.blobPath,
    cwd: opts.workspaceDir,
    onReadEntry: () => {
      files += 1;
    },
    // no chown (runs as the core process user); drop links (hardening). The
    // `unknown` param accepts tar's union entry types; `.type` is read defensively.
    filter: (path: string, entry: unknown) => {
      void path;
      const t = (entry as { type?: string }).type ?? "";
      return t !== "SymbolicLink" && t !== "Link";
    },
  });
  return { files };
}