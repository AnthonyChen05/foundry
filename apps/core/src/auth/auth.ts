import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { FoundryDb } from "../db/open.js";
import { apiKeys, sessions, users } from "../db/schema.js";
import { hashToken } from "../vault/vault.js";

/**
 * Auth: hashed API keys for the REST plane, session tokens for WS (issued by
 * auth.login). Plaintext is shown once at creation; only sha256 lives in DB.
 * v0 is single-admin (ADR-008): any valid, non-revoked key = owner access.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AuthUser {
  userId: string;
}

export interface IssuedKey {
  id: string;
  name: string;
  /** Plaintext — returned ONCE by the create call, never stored or echoed. */
  plaintext: string;
}

export interface IssuedSession {
  plaintext: string;
  expiresAt: number;
}

export class AuthService {
  constructor(private readonly dbx: FoundryDb) {}

  /**
   * First-boot bootstrap: create the owner user and one root admin key.
   * Returns the plaintext key only on mint; callers log it once.
   */
  async ensureBootstrap(keyMinter: (name: string) => IssuedKey): Promise<{ userId: string; issuedKey?: IssuedKey }> {
    const now = Date.now();
    let user = this.dbx.db.select().from(users).limit(1).get();
    if (!user) {
      const userId = `u_${randomBytes(8).toString("hex")}`;
      this.dbx.db.insert(users).values({ id: userId, name: "system", createdAt: now }).run();
      user = this.dbx.db.select().from(users).limit(1).get();
    }
    if (!user) throw new Error("failed to create bootstrap user");
    const existing = this.dbx.db.select().from(apiKeys).limit(1).get();
    if (existing) return { userId: user.id };
    const issued = keyMinter("root (auto-minted at first boot)");
    this.insertKey({ userId: user.id, name: issued.name, keyHash: hashToken(issued.plaintext) });
    return { userId: user.id, issuedKey: issued };
  }

  insertKey(row: { userId: string; name: string; keyHash: string }): string {
    const id = randomBytes(6).toString("hex");
    this.dbx.db.insert(apiKeys).values({
      id,
      userId: row.userId,
      name: row.name,
      keyHash: row.keyHash,
      createdAt: Date.now(),
    }).run();
    return id;
  }

  /** Verify a REST Bearer key / session token. Returns the owning user. */
  verifyToken(token: string): AuthUser | undefined {
    const h = hashToken(token);
    const key = this.dbx.db
      .select({ userId: apiKeys.userId })
      .from(apiKeys)
      // Revoked keys must not verify (same condition as sessions below).
      .where(and(eq(apiKeys.keyHash, h), isNull(apiKeys.revokedAt)))
      .get();
    if (key) {
      this.dbx.db.update(apiKeys).set({ lastUsedAt: Date.now() }).where(eq(apiKeys.keyHash, h)).run();
      return { userId: key.userId };
    }
    const session = this.dbx.db
      .select({ userId: sessions.userId, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(and(eq(sessions.tokenHash, h), isNull(sessions.revokedAt)))
      .get();
    if (session) {
      if (session.expiresAt !== null && session.expiresAt < Date.now()) return undefined;
      return { userId: session.userId };
    }
    return undefined;
  }

  /** auth.login: exchange an API key for a session token. */
  issueSession(apiKey: string): IssuedSession | undefined {
    const user = this.verifyToken(apiKey);
    if (!user) return undefined;
    const plaintext = `fnds_${randomBytes(32).toString("base64url")}`;
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.dbx.db
      .insert(sessions)
      .values({
        id: randomBytes(6).toString("hex"),
        userId: user.userId,
        tokenHash: hashToken(plaintext),
        createdAt: Date.now(),
        expiresAt,
      })
      .run();
    return { plaintext, expiresAt };
  }

  /** Mint a long-lived API key (admin.keys.*) — plaintext returned once. */
  mintKey(userId: string, name: string): IssuedKey {
    const plaintext = `fnd_${randomBytes(24).toString("base64url")}`;
    const id = this.insertKey({ userId, name, keyHash: hashToken(plaintext) });
    return { id, name, plaintext };
  }

  revokeKey(userId: string, keyId: string): boolean {
    const res = this.dbx.db
      .update(apiKeys)
      .set({ revokedAt: Date.now() })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .run();
    return (res.changes ?? 0) > 0;
  }

  listKeys(userId: string) {
    return this.dbx.db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId))
      .all();
  }
}