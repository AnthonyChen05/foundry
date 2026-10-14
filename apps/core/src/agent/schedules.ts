import { and, eq, lte } from "drizzle-orm";
import type { Schedule } from "@foundry/protocol";
import type { AppConfig } from "../config.js";
import type { FoundryDb } from "../db/open.js";
import {
  conversations,
  schedules as schedulesTable,
  settings as settingsTable,
} from "../db/schema.js";
import type { EmitFn } from "../gateway/chat.js";
import type { ChatService } from "../gateway/chat.js";
import type { NotifyService } from "../gateway/notify.js";
import type { ProviderStore } from "../providers/store.js";
import type { AgentRunner } from "./runtime.js";
import { ulid } from "../util/ulid.js";

/**
 * Schedules (build-order P3 task 2): cron or every-N-seconds triggers that
 * append their stored prompt to a conversation and launch an AGENT run
 * (trigger "schedule"). One tick every 30 s (FOUNDRY_TICK_MS); a missed
 * window (process down) COALESCES to a single fire and next_run_at recomputes
 * from now, not from the missed slot — catch-up once per wake (OpenClaw
 * semantics). Schedule rows are the truth; the ticker is stateless.
 */

// ---------------------------------------------------------------------------
// cron parser (5 fields: minute hour day-of-month month day-of-week)
// ---------------------------------------------------------------------------

export interface CronParts {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
  domStarred: boolean;
  dowStarred: boolean;
}

function parseField(field: string, min: number, max: number): number[] | undefined {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const piece = part.trim();
    if (piece.length === 0) return undefined;
    let range = piece;
    let step = 1;
    const stepIdx = piece.indexOf("/");
    if (stepIdx >= 0) {
      const stepRaw = Number(piece.slice(stepIdx + 1));
      if (!Number.isInteger(stepRaw) || stepRaw < 1) return undefined;
      step = stepRaw;
      range = piece.slice(0, stepIdx);
      if (range.length === 0) return undefined; // bare "/5" without a range
    }
    if (range === "*") {
      if (stepIdx < 0) {
        for (let v = min; v <= max; v++) out.add(v);
      } else {
        for (let v = min; v <= max; v += step) out.add(v);
      }
      continue;
    }
    const dashIdx = range.indexOf("-");
    let lo: number;
    let hi: number;
    if (dashIdx >= 0) {
      lo = Number(range.slice(0, dashIdx));
      hi = Number(range.slice(dashIdx + 1));
    } else {
      lo = Number(range);
      hi = stepIdx >= 0 ? max : lo; // "5/2" == "5-<max>/2" (POSIX-flavored)
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return undefined;
    if (lo < min || hi > max || lo > hi) return undefined;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) return undefined;
  return [...out].sort((a, b) => a - b);
}

/**
 * Parse a 5-field cron spec (`0 9 * * 1-5`). Local time. DOW 7 == Sunday
 * (normalized to 0); when both DOM and DOW are restricted, POSIX OR applies.
 * Returns undefined when invalid.
 */
export function parseCron(spec: string): CronParts | undefined {
  const fields = spec.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const minute = parseField(fields[0] ?? "", 0, 59);
  const hour = parseField(fields[1] ?? "", 0, 23);
  const dom = parseField(fields[2] ?? "", 1, 31);
  const month = parseField(fields[3] ?? "", 1, 12);
  const dowRaw = parseField(fields[4] ?? "", 0, 7);
  if (minute === undefined || hour === undefined || dom === undefined || month === undefined || dowRaw === undefined) {
    return undefined;
  }
  return {
    minute,
    hour,
    dom,
    month,
    dow: [...new Set(dowRaw.map((v) => (v === 7 ? 0 : v)))] as number[],
    domStarred: (fields[2] ?? "").trim() === "*",
    dowStarred: (fields[4] ?? "").trim() === "*",
  };
}

/** Next matching LOCAL minute strictly after `afterMs`. */
export function nextCronAfter(parts: CronParts, afterMs: number, maxDays = 366 * 8): number | undefined {
  const from = new Date(afterMs);
  for (let day = 0; day < maxDays; day++) {
    // new Date rolls overflow days (Jan 32 → Feb 1) — safe day arithmetic.
    // Day 0 (today) is scanned like any other: earlier slots today fail the
    // `t > afterMs` filter below, later ones are real candidates.
    const dayD = new Date(from.getFullYear(), from.getMonth(), from.getDate() + day, 0, 0, 0, 0);
    if (!parts.month.includes(dayD.getMonth() + 1)) continue;
    const domHit = parts.dom.includes(dayD.getDate());
    const dowHit = parts.dow.includes(dayD.getDay());
    if (parts.domStarred && parts.dowStarred) {
      // always true
    } else if (parts.domStarred) {
      if (!dowHit) continue;
    } else if (parts.dowStarred) {
      if (!domHit) continue;
    } else if (!domHit && !dowHit) {
      continue; // POSIX: both restricted → EITHER matches
    }
    for (const h of parts.hour) {
      for (const m of parts.minute) {
        const t = new Date(dayD.getFullYear(), dayD.getMonth(), dayD.getDate(), h, m, 0, 0).getTime();
        if (t > afterMs) return t;
      }
    }
  }
  return undefined;
}

/** Next fire for kind=every: `spec` is integer seconds ≥ 1. */
export function nextEveryAfter(spec: string, afterMs: number): number | undefined {
  const n = Number(spec.trim());
  if (!Number.isInteger(n) || n < 1) return undefined;
  return afterMs + n * 1000;
}

/** Compute the next due time for any valid spec; undefined = invalid spec. */
export function nextRunAfter(kind: "cron" | "every", spec: string, afterMs: number): number | undefined {
  if (kind === "cron") {
    const parts = parseCron(spec);
    return parts === undefined ? undefined : nextCronAfter(parts, afterMs);
  }
  return nextEveryAfter(spec, afterMs);
}

// ---------------------------------------------------------------------------
// scheduler service
// ---------------------------------------------------------------------------

export class SchedulerService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticking = false;
  private stopped = false;

  constructor(
    private readonly deps: {
      dbx: FoundryDb;
      chat: ChatService;
      providers: ProviderStore;
      agents: AgentRunner;
      config: AppConfig;
      emit: EmitFn;
      notify?: NotifyService;
      log?: (obj: object, msg: string) => void;
    },
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    const tick = (): void => {
      if (this.stopped) return;
      // Re-arm first: a slow fire never skews the next tick cadence.
      this.timer = setTimeout(tick, this.deps.config.scheduleTickMs);
      if (this.ticking) return; // serialize; never overlap
      this.ticking = true;
      void this.runTick()
        .catch((err: unknown) => {
          this.deps.log?.({ mod: "scheduler", err: String(err) }, "schedule tick failed");
        })
        .finally(() => {
          this.ticking = false;
        });
    };
    this.timer = setTimeout(tick, this.deps.config.scheduleTickMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One pass over due schedules (returns the schedule ids fired). */
  async runTick(nowMs = Date.now()): Promise<string[]> {
    const due = this.deps.dbx.db
      .select()
      .from(schedulesTable)
      .where(and(eq(schedulesTable.enabled, true), lte(schedulesTable.nextRunAt, nowMs)))
      .all()
      .sort((a, b) => a.nextRunAt - b.nextRunAt);
    const fired: string[] = [];
    for (const row of due) {
      this.fire(row);
      fired.push(row.id);
    }
    if (fired.length > 0) {
      this.deps.log?.({ mod: "scheduler", count: fired.length }, "fired due schedules");
    }
    return fired;
  }

  /**
   * Fire one schedule: new run on the target (or an auto-created) chat,
   * next_run_at recomputed from NOW (missed ticks coalesce to one fire).
   * Bookkeeping happens BEFORE the run so a broken spec disables the row
   * without ever firing; fire-and-forget — never blocks a tick.
   */
  private fire(row: typeof schedulesTable.$inferSelect): void {
    // Recompute from NOW (not from the missed slot): missed ticks coalesce.
    const next = nextRunAfter(row.kind === "cron" ? "cron" : "every", row.spec, Date.now());
    if (next === undefined) {
      this.deps.dbx.db.update(schedulesTable).set({ enabled: false }).where(eq(schedulesTable.id, row.id)).run();
      this.deps.log?.({ mod: "scheduler", schedule: row.id }, "schedule disabled: unparseable spec");
      return;
    }
    this.deps.dbx.db.update(schedulesTable).set({ nextRunAt: next }).where(eq(schedulesTable.id, row.id)).run();

    let conversationId: string | null = row.targetChatId;
    try {
      const wireModel = this.modelFor(row.model);
      if (conversationId === null || this.conversationOf(conversationId) === undefined) {
        const conv = this.deps.chat.createConversation(row.userId, `Schedule: ${row.name}`, wireModel);
        conversationId = conv.id;
        this.deps.dbx.db.update(schedulesTable).set({ targetChatId: conv.id }).where(eq(schedulesTable.id, row.id)).run();
      }
      const convId = conversationId; // narrowed

      this.deps.chat.appendMessage(convId, { role: "user", content: row.prompt });
      const runId = this.deps.chat.createRun({ userId: row.userId, conversationId: convId, model: wireModel, trigger: "schedule", agent: true });
      this.deps.notify?.push(`Schedule fired: ${row.name}`, row.prompt.slice(0, 200), runId);
      this.deps.log?.({ mod: "scheduler", schedule: row.id, runId }, "schedule fired");

      void this.deps.agents
        .startRun({
          runId,
          userId: row.userId,
          wireModel,
          conversationId: convId,
          emit: this.deps.emit,
          signal: new AbortController().signal,
        })
        .then(
          () => {
            // Terminal-state provenance on the schedule row.
            this.deps.dbx.db.update(schedulesTable).set({ lastRunId: runId }).where(eq(schedulesTable.id, row.id)).run();
          },
          (err: unknown) => {
            this.deps.log?.({ mod: "scheduler", schedule: row.id, runId, err: String(err) }, "scheduled run failed");
          },
        );
    } catch (err) {
      // next_run_at already advanced (bookkeeping is first) — this occurrence
      // is lost, logged; the row stays enabled for the next occurrence.
      this.deps.log?.({ mod: "scheduler", schedule: row.id, err: String(err) }, "schedule fire failed");
    }
  }

  private conversationOf(chatId: string): typeof conversations.$inferSelect | undefined {
    return this.deps.dbx.db.select().from(conversations).where(eq(conversations.id, chatId)).get();
  }

  /** schedule.model → validated against the catalog; else settings default_model; else first enabled model. */
  private modelFor(model: string | null): string {
    for (const candidate of [model ?? undefined, this.settingString("default_model")]) {
      if (candidate === undefined) continue;
      try {
        this.deps.chat.route(candidate);
        return candidate;
      } catch {
        this.deps.log?.({ mod: "scheduler", model: candidate }, "schedule model does not resolve — trying fallback");
      }
    }
    const first = this.deps.providers.listModels().find((m) => m.enabled);
    if (first === undefined) throw new Error("no enabled model in the catalog to run a schedule");
    return first.id;
  }

  private settingString(key: string): string | undefined {
    const row = this.deps.dbx.db.select().from(settingsTable).where(eq(settingsTable.key, key)).get();
    const v = row?.value;
    return typeof v === "string" && v.length > 0 ? v : undefined;
  }

  // -- CRUD (REST admin plane) -----------------------------------------------------

  create(params: {
    userId: string;
    name: string;
    kind: "cron" | "every";
    spec: string;
    prompt: string;
    model?: string | null;
    targetChatId?: string | null;
    enabled?: boolean;
  }): Schedule {
    const next = nextRunAfter(params.kind, params.spec, Date.now());
    if (next === undefined) throw new Error(`invalid schedule spec: ${params.spec}`);
    const id = `sch_${ulid()}`;
    const now = Date.now();
    this.deps.dbx.db
      .insert(schedulesTable)
      .values({
        id,
        userId: params.userId,
        name: params.name,
        kind: params.kind,
        spec: params.spec,
        prompt: params.prompt,
        model: params.model ?? null,
        targetChatId: params.targetChatId ?? null,
        enabled: params.enabled ?? true,
        nextRunAt: next,
        createdAt: now,
      })
      .run();
    const made = this.get(params.userId, id);
    if (made === undefined) throw new Error("schedule row vanished after insert");
    return made;
  }

  get(userId: string, id: string): Schedule | undefined {
    const row = this.deps.dbx.db
      .select()
      .from(schedulesTable)
      .where(and(eq(schedulesTable.id, id), eq(schedulesTable.userId, userId)))
      .get();
    return row === undefined ? undefined : this.rowWire(row);
  }

  list(userId: string): Schedule[] {
    return this.deps.dbx.db
      .select()
      .from(schedulesTable)
      .where(eq(schedulesTable.userId, userId))
      .all()
      .map((r) => this.rowWire(r));
  }

  patch(userId: string, id: string, patch: {
    name?: string;
    prompt?: string;
    spec?: string;
    model?: string | null;
    targetChatId?: string | null;
    enabled?: boolean;
    reschedule?: boolean;
  }): Schedule | undefined {
    const row = this.deps.dbx.db
      .select()
      .from(schedulesTable)
      .where(and(eq(schedulesTable.id, id), eq(schedulesTable.userId, userId)))
      .get();
    if (row === undefined) return undefined;
    const set: Partial<typeof schedulesTable.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.prompt !== undefined) set.prompt = patch.prompt;
    if (patch.model !== undefined) set.model = patch.model;
    if (patch.targetChatId !== undefined) set.targetChatId = patch.targetChatId;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.spec !== undefined) {
      if (nextRunAfter(row.kind === "cron" ? "cron" : "every", patch.spec, Date.now()) === undefined) {
        throw new Error(`invalid schedule spec: ${patch.spec}`);
      }
      set.spec = patch.spec;
    }
    const changed =
      patch.spec !== undefined || patch.reschedule === true || (patch.enabled === true && !row.enabled);
    if (changed && set.enabled !== false) {
      const next = nextRunAfter(row.kind === "cron" ? "cron" : "every", set.spec ?? row.spec, Date.now());
      if (next !== undefined) set.nextRunAt = next;
    }
    this.deps.dbx.db.update(schedulesTable).set(set).where(eq(schedulesTable.id, id)).run();
    return this.get(userId, id);
  }

  remove(userId: string, id: string): boolean {
    const res = this.deps.dbx.db
      .delete(schedulesTable)
      .where(and(eq(schedulesTable.id, id), eq(schedulesTable.userId, userId)))
      .run();
    return (res.changes ?? 0) > 0;
  }

  private rowWire(r: typeof schedulesTable.$inferSelect): Schedule {
    return {
      id: r.id,
      name: r.name,
      kind: r.kind === "cron" ? "cron" : "every",
      spec: r.spec,
      prompt: r.prompt,
      model: r.model,
      targetChatId: r.targetChatId,
      enabled: r.enabled,
      nextRunAt: new Date(r.nextRunAt).toISOString(),
      lastRunId: r.lastRunId,
      createdAt: new Date(r.createdAt).toISOString(),
    };
  }
}