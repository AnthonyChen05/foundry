import type { FileEntry } from "@foundry/protocol";
import type { SandboxService } from "../sandbox/service.js";
import type { EnvHandle, FileStat } from "../sandbox/types.js";
import { SandboxError } from "../sandbox/types.js";

/**
 * Client file plane (protocol.md §1.3 `files.*`): thin JSON adapters over the
 * sandbox driver's FileApi — workspace-relative paths, driver-enforced jail,
 * NO host filesystem access (guardrail #1). `envId` selects the env when the
 * client knows it; otherwise the user's default (workspace) env is used.
 */
export class FilesService {
  constructor(private readonly deps: { sandbox: SandboxService }) {}

  private async envFor(userId: string, envId?: string): Promise<EnvHandle> {
    if (envId === undefined) return this.deps.sandbox.ensureEnv(userId);
    // Multi-user audit (P5): explicit envs must belong to the caller. Both
    // errors are 404 so foreign ids and unknown ids are indistinguishable.
    const owner = this.deps.sandbox.envOwner(envId);
    if (owner === undefined || owner !== userId) {
      throw new SandboxError(`unknown sandbox env: ${envId}`, 404);
    }
    return this.deps.sandbox.getEnvMust(envId);
  }

  private static toEntry(s: FileStat): FileEntry {
    return { path: s.path, size: s.size, mtime: new Date(s.mtimeMs).toISOString(), isDir: s.isDir };
  }

  async list(userId: string, envId: string | undefined, path: string): Promise<FileEntry[]> {
    const env = await this.envFor(userId, envId);
    const rows = await env.driver.files.list(env.envId, path.length === 0 ? "." : path);
    return rows.map(FilesService.toEntry);
  }

  async read(userId: string, envId: string | undefined, path: string): Promise<{ content: string; b64?: boolean }> {
    const env = await this.envFor(userId, envId);
    const { content, isText } = await env.driver.files.read(env.envId, path);
    if (isText) return { content: content.toString("utf8") };
    return { content: content.toString("base64"), b64: true };
  }

  async write(userId: string, envId: string | undefined, path: string, content: string, b64?: boolean): Promise<void> {
    const env = await this.envFor(userId, envId);
    const data = b64 === true ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
    await env.driver.files.write(env.envId, path, data);
  }

  async mkdir(userId: string, envId: string | undefined, path: string, recursive?: boolean): Promise<void> {
    const env = await this.envFor(userId, envId);
    await env.driver.files.mkdir(env.envId, path, recursive !== false);
  }

  async rm(userId: string, envId: string | undefined, path: string, recursive?: boolean): Promise<void> {
    const env = await this.envFor(userId, envId);
    await env.driver.files.rm(env.envId, path, recursive === true);
  }

  async stat(userId: string, envId: string | undefined, path: string): Promise<FileEntry> {
    const env = await this.envFor(userId, envId);
    const st = await env.driver.files.stat(env.envId, path);
    return FilesService.toEntry(st);
  }
}