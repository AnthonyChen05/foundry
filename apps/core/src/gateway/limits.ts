/**
 * P5 limits: in-process rate limits (token bucket) + per-user concurrent-run
 * quota. State lives in memory — single-process backend by design (ADR-007);
 * limits reset on restart, which is acceptable for self-hosted metering.
 *
 * Enforced at the two expensive boundaries: WS `chat.send` (per user) and the
 * OpenAI REST plane (per api-key identity). Rejections use the protocol's
 * `capacity` code / OpenAI envelope with 429 so every client type gets its
 * native error shape.
 */

/**
 * The limit set wired through runtime: REST/egress buckets + the WS chat
 * bucket + the per-user concurrent-run quota.
 */
export interface Limits {
  /** OpenAI REST + egress plane, per authed identity (key/user). */
  api: RateLimiter;
  /** WS chat.send, per user. */
  chat: RateLimiter;
  /** Per-user concurrent runs. */
  runs: ConcurrentRunQuota;
}

interface Bucket {
  tokens: number;
  lastAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly perMinute: number,
    /** Bucket burst capacity (defaults to perMinute). */
    private readonly burst?: number,
  ) {}

  /** consume(1) — true when allowed AND the token taken. */
  take(key: string, now = Date.now(), cost = 1): boolean {
    const capacity = this.burst ?? this.perMinute;
    let b = this.buckets.get(key);
    if (b === undefined) {
      b = { tokens: capacity, lastAt: now };
      this.buckets.set(key, b);
    }
    const refill = ((now - b.lastAt) / 60_000) * this.perMinute;
    if (refill > 0) {
      b.tokens = Math.min(capacity, b.tokens + refill);
      b.lastAt = now;
    }
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Per-user concurrent-run quota; the count comes from the runs table
 * (queued/running/waiting_approval), so it survives restarts and self-heals —
 * a stateless check before run creation rather than reserve/release bookkeeping.
 */
export class ConcurrentRunQuota {
  constructor(
    private readonly countActive: (userId: string) => number,
    readonly max: number,
  ) {}

  /** True when the user may start one more run. */
  tryAcquire(userId: string): boolean {
    return this.countActive(userId) < this.max;
  }
}