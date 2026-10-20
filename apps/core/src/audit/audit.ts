import { desc } from "drizzle-orm";
import type { FoundryDb } from "../db/open.js";
import { audit } from "../db/schema.js";

/**
 * Append-only audit log (P5). Security-relevant actions across all planes
 * land here: auth (login attempts, password changes, key issuance), gate
 * resolutions, admin mutations, executor registration, chat pushes. One
 * writer (`record`) — callers fire-and-forget; a logging failure must never
 * take an action down with it.
 *
 * Redaction discipline = run_events: no keys, tokens, or secrets in `meta`.
 */
export interface AuditEntry {
  userId?: string;
  action: string;
  target?: string;
  outcome?: "ok" | "denied" | "timeout" | "error";
  meta?: Record<string, unknown>;
}

export interface AuditRow {
  id: number;
  userId: string | null;
  at: number;
  action: string;
  target: string | null;
  outcome: string;
  meta: unknown;
}

export class AuditService {
  constructor(private readonly dbx: FoundryDb) {}

  record(entry: AuditEntry): void {
    try {
      this.dbx.db.insert(audit).values({
        ...(entry.userId !== undefined ? { userId: entry.userId } : {}),
        at: Date.now(),
        action: entry.action,
        ...(entry.target !== undefined ? { target: entry.target } : {}),
        outcome: entry.outcome ?? "ok",
        ...(entry.meta !== undefined ? { meta: entry.meta } : {}),
      }).run();
    } catch {
      // Audit must never break the action it observes (log would loop).
    }
  }

  /** Newest-first page (admin REST). */
  list(limit = 100, before?: number): AuditRow[] {
    const rows = this.dbx.db
      .select()
      .from(audit)
      .orderBy(desc(audit.id))
      .limit(Math.min(Math.max(limit, 1), 1000))
      .all();
    return rows
      .map((r) => r as unknown as AuditRow)
      .filter((r) => (before === undefined ? true : r.at < before));
  }
}