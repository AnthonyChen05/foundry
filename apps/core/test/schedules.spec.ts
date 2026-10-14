import { describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { schedules as schedulesTable, runs as runsTable } from "../src/db/schema.js";
import { parseCron, nextCronAfter, nextEveryAfter } from "../src/agent/schedules.js";
import { startServer, type TestCtx } from "./helpers.js";

/** Schedules (build-order P3 #2): cron/expiry parser, 30s→fast tick firing
 * (runs with the stored prompt on an auto chat), missed-tick coalescing,
 * broken-spec auto-disable, admin REST. */

let ctx: TestCtx;

/** Parse a spec and take the next occurrence as a Date (undefined if broken). */
function nextFromSpec(spec: string, after: Date): Date | undefined {
  const parts = parseCron(spec);
  if (parts === undefined) return undefined;
  const next = nextCronAfter(parts, after.getTime());
  return next === undefined ? undefined : new Date(next);
}

async function boot(overrides?: Parameters<typeof startServer>[0]): Promise<{
  waitFor: (cond: () => boolean | Promise<boolean>, what?: string, timeoutMs?: number) => Promise<void>;
  userId: string;
}> {
  ctx = await startServer({ scheduleTickMs: 150, ...(overrides ?? {}) });
  const userId = ctx.server.rt.auth.verifyToken(ctx.server.token)?.userId;
  if (userId === undefined) throw new Error("test token doesn't resolve to a user");
  const waitFor = async (
    cond: () => boolean | Promise<boolean>,
    what = "condition",
    timeoutMs = 8000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await cond()) return;
      await delay(25);
    }
    throw new Error(`timeout waiting for ${what}`);
  };
  return { waitFor, userId };
}

/** Local Date for y/m/d h:m on this machine (cron is local time). */
function at(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(y, mo - 1, d, h, mi);
}

describe("cron parser (unit)", () => {
  it("rounds up to the next matching minute/day", () => {
    // Wed 2026-10-07 10:30 → next 09:00 daily is Thu.
    expect(nextFromSpec("0 9 * * *", at(2026, 10, 7, 10, 30))).toEqual(at(2026, 10, 8, 9, 0));
    // Just before match: fires later THIS day.
    expect(nextFromSpec("30 14 * * *", at(2026, 10, 7, 14, 0))).toEqual(at(2026, 10, 7, 14, 30));
    // Exact match time is excluded (next occurrence, not "now").
    expect(nextFromSpec("0 0 * * *", at(2026, 10, 7, 0, 0))).toEqual(at(2026, 10, 8, 0, 0));
  });

  it("handles */n, ranges, lists, stepping and dow 7→0", () => {
    expect(nextFromSpec("*/15 * * * *", at(2026, 10, 7, 10, 31))).toEqual(at(2026, 10, 7, 10, 45));
    expect(nextFromSpec("0 9 * * 1-5", at(2026, 10, 3, 12, 0))).toEqual(at(2026, 10, 5, 9, 0)); // Sat → Mon
    expect(nextFromSpec("0 9 * * 0,6", at(2026, 10, 7, 12, 0))).toEqual(at(2026, 10, 10, 9, 0)); // Wed → Sat
    // POSIX: dow 7 == sunday.
    expect(nextFromSpec("0 12 * * 7", at(2026, 10, 7, 12, 0))).toEqual(at(2026, 10, 11, 12, 0));
    // Stepped range "5/2" = 5,7,9,…,59 minutes.
    expect(nextFromSpec("5/2 * * * *", at(2026, 10, 7, 10, 6))).toEqual(at(2026, 10, 7, 10, 7));
  });

  it("applies the POSIX dom/dow OR rule", () => {
    // "0 0 13 * 5" → day 13 OR any Friday.
    // Wed 2026-10-07 → Friday Oct 9 (before the 13th).
    expect(nextFromSpec("0 0 13 * 5", at(2026, 10, 7, 0, 0))).toEqual(at(2026, 10, 9, 0, 0));
    // Sat Nov 14 2026: 13th passed (it was a Friday) → next Friday is the 20th.
    expect(nextFromSpec("0 0 13 * 5", at(2026, 11, 14, 12, 0))).toEqual(at(2026, 11, 20, 0, 0));
  });

  it("rejects malformed specs", () => {
    expect(nextFromSpec("61 * * * *", new Date())).toBeUndefined();
    expect(nextFromSpec("* 25 * * *", new Date())).toBeUndefined();
    expect(nextFromSpec("not a cron", new Date())).toBeUndefined();
    expect(nextFromSpec("0 9 * * * *", new Date())).toBeUndefined(); // 6 fields
    expect(nextEveryAfter("0", new Date().getTime())).toBeUndefined();
    expect(nextEveryAfter("abc", new Date().getTime())).toBeUndefined();
    expect(nextEveryAfter("10", at(2026, 10, 7, 10, 0).getTime())).toBe(at(2026, 10, 7, 10, 0).getTime() + 10_000);
  });
});

describe("scheduler tick", () => {
  it("fires a due schedule: run with the stored prompt on an auto chat", async () => {
    const { waitFor, userId } = await boot();
    const res = await fetch(`${ctx.server.baseUrl}/v1/admin/schedules`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.server.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "sky-watch", kind: "every", spec: "1", prompt: "check the sky and report" }),
    });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { id: string; nextRunAt: string; kind: string; prompt: string; enabled: boolean };
    expect(made.kind).toBe("every");
    expect(new Date(made.nextRunAt).getTime()).toBeGreaterThan(Date.now() - 5_000);

    await waitFor(() => {
      const rows = ctx.server.rt.db.db.select().from(runsTable).all().filter((r) => r.trigger === "schedule");
      return rows.length === 1;
    }, "schedule-triggered run", 6000);

    const run = ctx.server.rt.db.db.select().from(runsTable).all().find((r) => r.trigger === "schedule");
    await waitFor(async () => (ctx.server.rt.chat.getRun(run?.id as string)?.status ?? "") === "done", "schedule run done", 10_000);

    // The run attaches to a persisted server-owned chat named "Schedule: …".
    const sched = ctx.server.rt.db.db.select().from(schedulesTable).all().find((s) => s.id === made.id);
    expect(sched?.enabled).toBe(true);
    expect(sched?.lastRunId).toBe(run?.id);
    const conv = ctx.server.rt.db.db.select().from(schedulesTable).all().find((s) => s.id === made.id);
    expect(conv?.targetChatId).not.toBeNull();
    const convRow = ctx.server.rt.db.db.select().from(runsTable).all().find((r) => r.id === run?.id);
    expect(convRow?.conversationId).toBe(sched?.targetChatId);
    expect(run?.userId).toBe(userId);
    void run;
  });

  it("coalesces missed ticks: one catch-up run, next_run_at recomputed from NOW", async () => {
    const { waitFor } = await boot();
    const created = ctx.server.rt.scheduler.create({
      userId: ctx.server.rt.auth.verifyToken(ctx.server.token)?.userId as string,
      name: "overdue",
      kind: "every",
      spec: "120",
      prompt: "catch up",
    });
    // Simulate downtime: the deadline blew past 60s ago.
    ctx.server.rt.db.db
      .update(schedulesTable)
      .set({ nextRunAt: Date.now() - 60_000 })
      .where(eq(schedulesTable.id, created.id))
      .run();

    await waitFor(() => {
      const sched = ctx.server.rt.db.db.select().from(schedulesTable).all().find((s) => s.id === created.id);
      return sched !== undefined && (sched.lastRunId ?? "").length > 0 && sched.nextRunAt > Date.now() + 100_000;
    }, "coalesced fire + rescheduled from now", 6000);

    // Exactly one catch-up run — not one per missed 2-minute window.
    const fireCount = ctx.server.rt.db.db
      .select()
      .from(runsTable)
      .all()
      .filter((r) => r.conversationId === created.targetChatId || r.trigger === "schedule").length;
    expect(fireCount).toBe(1);
    await delay(400); // two more tick periods with the next fire 2 min out
    expect(ctx.server.rt.db.db.select().from(runsTable).all().filter((r) => r.trigger === "schedule").length).toBe(1);
  });

  it("disables a schedule whose spec broke after creation", async () => {
    const { waitFor } = await boot();
    const userId = ctx.server.rt.auth.verifyToken(ctx.server.token)?.userId as string;
    const created = ctx.server.rt.scheduler.create({ userId, name: "will-break", kind: "every", spec: "1", prompt: "boom" });
    ctx.server.rt.db.db.update(schedulesTable).set({ spec: "not a spec" }).where(eq(schedulesTable.id, created.id)).run();
    // Force due → fire() hits the unparseable spec → row disabled, no run.
    ctx.server.rt.db.db.update(schedulesTable).set({ nextRunAt: Date.now() - 5_000 }).where(eq(schedulesTable.id, created.id)).run();
    await waitFor(() => ctx.server.rt.db.db.select().from(schedulesTable).all().find((s) => s.id === created.id)?.enabled === false, "row auto-disabled", 4000);
    expect(ctx.server.rt.db.db.select().from(runsTable).all().filter((r) => r.trigger === "schedule").length).toBe(0);
  });
});

describe("schedule admin REST", () => {
  it("CRUD round-trip with invalid-spec 400s and unknown-id 404s", async () => {
    await boot();
    const auth = { Authorization: `Bearer ${ctx.server.token}`, "Content-Type": "application/json" };
    const baseUrl = ctx.server.baseUrl;

    const bad = await fetch(`${baseUrl}/v1/admin/schedules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "x", kind: "cron", spec: "0 25 * * *", prompt: "p" }) });
    expect(bad.status).toBe(400);
    const badBody = await fetch(`${baseUrl}/v1/admin/schedules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "x", kind: "hourly", spec: "0 * * * *", prompt: "p" }) });
    expect(badBody.status).toBe(400);

    const created = await fetch(`${baseUrl}/v1/admin/schedules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "daily-9", kind: "cron", spec: "0 9 * * *", prompt: "morning notes" }) });
    expect(created.status).toBe(201);
    const made = (await created.json()) as { id: string; spec: string; prompt: string };
    expect(made.prompt).toBe("morning notes");

    const list = await fetch(`${baseUrl}/v1/admin/schedules`, { headers: auth });
    expect(((await list.json()) as { schedules: unknown[] }).schedules.length).toBe(1);

    const patched = await fetch(`${baseUrl}/v1/admin/schedules/${made.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ prompt: "notes v2", enabled: false }) });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { prompt: string; enabled: boolean; nextRunAt: string })).toMatchObject({ prompt: "notes v2", enabled: false });

    const missing = await fetch(`${baseUrl}/v1/admin/schedules/sch_nope`, { headers: auth });
    expect(missing.status).toBe(404);

    const del = await fetch(`${baseUrl}/v1/admin/schedules/${made.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${ctx.server.token}` } });
    expect(del.status).toBe(200);
    expect((await fetch(`${baseUrl}/v1/admin/schedules`, { headers: auth })).status).toBe(200);
    const delAgain = await fetch(`${baseUrl}/v1/admin/schedules/${made.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${ctx.server.token}` } });
    expect(delAgain.status).toBe(404);
  });
});