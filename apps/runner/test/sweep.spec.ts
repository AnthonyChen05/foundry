import { describe, expect, it } from "vitest";
import { sweepRunnerContainers } from "../src/sweep.js";

/** The boot sweep only touches `foundry.runner=1` — core's sandbox label is untouched. */

describe("runner boot sweep", () => {
  it("stops+removes ONLY runner-labeled containers", async () => {
    const touched: string[] = [];
    const stub = {
      listContainers: async (opts: { all?: boolean; filters?: { label?: string[] } }) => {
        expect(opts.filters?.label).toEqual(["foundry.runner=1"]);
        return [
          { Id: "aaa111111111", State: "running" },
          { Id: "bbb222222222", State: "exited" },
        ];
      },
      getContainer: (id: string) => ({
        stop: async () => { touched.push(`stop:${id}`); return undefined; },
        remove: async () => { touched.push(`rm:${id}`); return undefined; },
      }),
    } as never;
    const n = await sweepRunnerContainers(stub as never);
    expect(n).toBe(2);
    expect(touched).toEqual([
      "stop:aaa111111111", "rm:aaa111111111",
      "rm:bbb222222222",
    ]); // exited containers skip the stop
  });

  it("an empty list sweeps nothing and resolves 0", async () => {
    const stub = { listContainers: async () => [], getContainer: () => { throw new Error("never"); } } as never;
    expect(await sweepRunnerContainers(stub as never)).toBe(0);
  });
});