import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { FoundryDb } from "../db/open.js";
import { apiKeys, sessions, users } from "../db/schema.js";
import { hashToken } from "../vault/vault.js";

/**
 * Auth (ADR-006): user-facing login = username + password (scrypt-hashed at
 * rest; plaintext only on the local wire). Login issues a session token, used
 * as Bearer on REST and inside WS `connect`. API keys remain a separate
 * credential class for programmatic OpenAI-compatible clients — they
 * authenticate, but are NOT a login method. Plaintext tokens/keys are shown
 * once at creation; only sha256 hashes live in DB. v0 is single-admin
 * (ADR-008): any valid, non-revoked credential = owner access.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// OWASP-recommended interactive-login scrypt parameters.
const SCRYPT_N = 1 << 15; // 32768
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

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

function scryptDerive(password: string, salt: Buffer, keylen: number, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // OpenSSL's default maxmem is 32 MiB while N=2^15, r=8 needs exactly that
    // much ("memory limit exceeded" without it) — pass an explicit budget:
    // 2x the cost, capped so a corrupted stored hash can't request absurd N.
    const safeN = Math.min(N, 1 << 22);
    const safeR = Math.min(r, 64);
    scrypt(
      password.normalize("NFKC"),
      salt,
      keylen,
      { N: safeN, r: safeR, p, maxmem: 2 * 128 * safeN * safeR },
      (err, derived) => {
        if (err !== null) {
          reject(err);
          return;
        }
        resolve(derived);
      },
    );
  });
}

/** "scrypt:N:r:p:salt:hash" — self-describing, so parameters can evolve. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptDerive(password, salt, SCRYPT_KEYLEN, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("base64")}:${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p, salt, hash] = [parts[1], parts[2], parts[3], parts[4], parts[5]];
  if (n === undefined || r === undefined || p === undefined || salt === undefined || hash === undefined) {
    return false;
  }
  const expect = Buffer.from(hash, "base64");
  const derived = await scryptDerive(password, Buffer.from(salt, "base64"), expect.length, Number(n), Number(r), Number(p));
  return derived.length === expect.length && timingSafeEqual(derived, expect);
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

  /**
   * First-boot credential bootstrap (ADR-006): backfill username + password
   * onto the owner user (pre-password rows have NULLs). Idempotent: a no-op
   * the moment any user has a username. Password change goes through
   * setPassword; deleting the users row's username re-runs this on next boot.
   */
  async ensureUserCredentials(username: string, password: string): Promise<boolean> {
    const anyUser = this.dbx.db.select({ id: users.id }).from(users).where(isNotNull(users.username)).get();
    if (anyUser) return false;
    const user = this.dbx.db.select().from(users).limit(1).get();
    if (!user) return false;
    this.dbx.db
      .update(users)
      .set({ username, passwordHash: await hashPassword(password) })
      .where(eq(users.id, user.id))
      .run();
    return true;
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

  /** Issue a fresh session for an already-authenticated user. */
  private newSession(userId: string): IssuedSession {
    const plaintext = `fnds_${randomBytes(32).toString("base64url")}`;
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.dbx.db
      .insert(sessions)
      .values({
        id: randomBytes(6).toString("hex"),
        userId,
        tokenHash: hashToken(plaintext),
        createdAt: Date.now(),
        expiresAt,
      })
      .run();
    return { plaintext, expiresAt };
  }

  /** auth.login: username + password → session token. */
  async loginWithPassword(username: string, password: string): Promise<IssuedSession | undefined> {
    const row = this.dbx.db.select().from(users).where(eq(users.username, username)).get();
    if (!row?.passwordHash) return undefined;
    if (!(await verifyPassword(password, row.passwordHash))) return undefined;
    return this.newSession(row.id);
  }

  /**
   * Self-service password change. When the user has no password yet
   * (pre-password row the boot could not backfill), currentPassword is not
   * required. Returns false on wrong/missing current password.
   */
  async setPassword(userId: string, currentPassword: string | undefined, newPassword: string): Promise<boolean> {
    const row = this.dbx.db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) return false;
    if (row.passwordHash !== null && row.passwordHash !== "") {
      if (currentPassword === undefined || !(await verifyPassword(currentPassword, row.passwordHash))) {
        return false;
      }
    }
    this.dbx.db
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword) })
      .where(eq(users.id, userId))
      .run();
    return true;
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