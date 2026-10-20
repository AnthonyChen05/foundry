import { describe, expect, it } from "vitest";
import { ConcurrentRunQuota, RateLimiter } from "../src/gateway/limits.js";

/**
 * P5 limits: token-bucket semantics (burst = capacity, linear per-minute
 * refill, per-key isolation) and the stateless per-user run quota.
 * `take` takes an injected clock — no timers, no flakiness.
 */

describe("RateLimiter", () => {
  it("drains a full bucket, then denies", () => {
    const rl = new RateLimiter(3);
    const t0 = 10_000;
    expect(rl.take("u1", t0)).toBe(true);
    expect(rl.take("u1", t0)).toBe(true);
    expect(rl.take("u1", t0)).toBe(true);
    expect(rl.take("u1", t0)).toBe(false);
    // zero refill at the same instant: still denied
    expect(rl.take("u1", t0)).toBe(false);
  });

  it("refills linearly at perMinute/60000 per ms", () => {
    const rl = new RateLimiter(6); // 6/min → 0.1/ms
    const t0 = 0;
    expect(rl.take("u", t0, 6)).toBe(true); // burst the whole bucket
    expect(rl.take("u", t0)).toBe(false); // empty
    // +30s → half a bucket (3 tokens) refilled
    expect(rl.take("u", t0 + 30_000, 3)).toBe(true);
    expect(rl.take("u", t0 + 30_000)).toBe(false);
    // +60s from the last refill → back to full (6)
    expect(rl.take("u", t0 + 30_000 + 60_000, 6)).toBe(true);
  });

  it("refill never exceeds capacity (burst < perMinute)", () => {
    const rl = new RateLimiter(10, 4); // rate 10/min, burst 4
    const t0 = 0;
    expect(rl.take("u", t0, 4)).toBe(true);
    expect(rl.take("u", t0 + 300_000, 4)).toBe(true); // long idle can't exceed burst
    expect(rl.take("u", t0 + 300_000)).toBe(false);
  });

  it("keys are independent", () => {
    const rl = new RateLimiter(1);
    const t0 = 0;
    expect(rl.take("a", t0)).toBe(true);
    expect(rl.take("a", t0)).toBe(false);
    expect(rl.take("b", t0)).toBe(true);
  });

  it("reset() clears all buckets", () => {
    const rl = new RateLimiter(1);
    const t0 = 0;
    expect(rl.take("a", t0)).toBe(true);
    expect(rl.take("a", t0)).toBe(false);
    rl.reset();
    expect(rl.take("a", t0)).toBe(true);
  });
});

describe("ConcurrentRunQuota", () => {
  it("allows up to max, denies when full, recovers as runs end", () => {
    let active = 0;
    const q = new ConcurrentRunQuota(() => active, 2);
    expect(q.max).toBe(2);
    expect(q.tryAcquire("u")).toBe(true);
    active = 1;
    expect(q.tryAcquire("u")).toBe(true);
    active = 2;
    expect(q.tryAcquire("u")).toBe(false);
    active = 1; // one run finished
    expect(q.tryAcquire("u")).toBe(true);
  });

  it("max 0 denies everything (emergency brake)", () => {
    const q = new ConcurrentRunQuota(() => 0, 0);
    expect(q.tryAcquire("anyone")).toBe(false);
  });
});