import type { AppConfig } from "../config.js";
import type { NotifyPushPayload } from "@foundry/protocol";

/**
 * Push notifications (build-order P3 task 5): self-hosted ntfy. Fire-and-
 * forget POSTs to `{FOUNDRY_NTFY_URL}/{FOUNDRY_NTFY_TOPIC}` with a Title
 * header — never blocks a run, never throws into the runtime. Every push is
 * also broadcast on the WS `notify.push` event so first-party clients see
 * exactly what the phone sees (sync directive: the server owns the event).
 */

type Emit = (event: string, channel: string, payload: unknown) => void;

export class NotifyService {
  constructor(
    private readonly deps: {
      config: AppConfig;
      emit?: Emit;
      log?: (obj: object, msg: string) => void;
    },
  ) {}

  private get enabled(): boolean {
    return this.deps.config.notifyNtfyUrl !== undefined && this.deps.config.notifyNtfyTopic !== undefined;
  }

  /** Push "run done" (summary attached when present). */
  runDone(runId: string, summary: string | undefined): void {
    const body = summary === undefined || summary.length === 0 ? "agent run finished" : summary;
    this.push("Run finished", body.slice(0, 500), runId);
  }

  /** Push "run failed" (first line of the error). */
  runFailed(runId: string, error: string): void {
    this.push("Run failed", error.slice(0, 500), runId);
  }

  /** Push "gate open" — the operator's phone needs to approve. */
  gateOpen(runId: string, tool: string): void {
    this.push(`Approval needed: ${tool}`, `Run ${runId} is waiting for approval`, runId);
  }

  push(title: string, body: string, runId?: string): void {
    this.deps.emit?.("notify.push", "notify", { title, body, ...(runId !== undefined ? { runId } : {}) } satisfies NotifyPushPayload);
    if (!this.enabled) return;
    const url = `${this.deps.config.notifyNtfyUrl?.replace(/\/$/, "")}/${this.deps.config.notifyNtfyTopic}`;
    void fetch(url, {
      method: "POST",
      headers: {
        "Title": title.slice(0, 120),
        "Tags": "robot",
      },
      body,
      signal: AbortSignal.timeout(5_000),
    }).catch((err: unknown) => {
      this.deps.log?.({ mod: "notify", err: String(err) }, "ntfy push failed");
    });
  }
}