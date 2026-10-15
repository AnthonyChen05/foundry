import type Dockerode from "dockerode";

/**
 * Boot sweep (ADR-015): the runner is the ONLY owner of containers labeled
 * `foundry.runner=1` (core-hosted sandboxes carry only `foundry.sandbox=1`).
 * After a runner crash/hard kill its old OT container keeps running — sweep it:
 * each (re)start starts from a clean slate, and the workspace DIR (not the
 * container) carries the files for re-materialization.
 */
export async function sweepRunnerContainers(
  docker: Dockerode,
  log?: (msg: string) => void,
): Promise<number> {
  const found = (await docker.listContainers({
    all: true,
    filters: { label: ["foundry.runner=1"] },
  })) as { Id: string; State: string }[];
  let swept = 0;
  for (const c of found) {
    const container = docker.getContainer(c.Id);
    if (c.State === "running" || c.State === "paused" || c.State === "restarting" || c.State === "created") {
      await container.stop({ t: 3 }).catch(() => undefined);
    }
    await container.remove({ force: true }).catch(() => undefined);
    swept += 1;
    log?.(`swept orphan container ${c.Id.slice(0, 12)} (${c.State})`);
  }
  return swept;
}