import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scryptSync,
} from "node:crypto";
import { createHash } from "node:crypto";

/**
 * Key vault (hard guardrail #2): provider API keys live ONLY here, encrypted
 * at rest with AES-256-GCM. Master key = FOUNDRY_MASTER_KEY (docs/data-model.md
 * vault table), expanded via scrypt so any passphrase length works. Keys are
 * never logged, never sent to clients, never placed in sandbox env (ADR-005).
 */

export class VaultNotConfiguredError extends Error {
  constructor() {
    super(
      "FOUNDRY_MASTER_KEY is not set — the vault cannot encrypt. Generate one with: " +
        `node -e "console.log(crypto.randomBytes(32).toString('base64url'))"`,
    );
    this.name = "VaultNotConfiguredError";
  }
}

export class VaultDecryptError extends Error {
  constructor(reason: string) {
    super(`vault decrypt failed: ${reason}`);
    this.name = "VaultDecryptError";
  }
}

/** Ciphertext triple matching the `vault` table columns. */
export interface VaultBlob {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
}

/** Key derivation parameters — versioned so rotations can re-derive later. */
const KDF = { salt: "foundry-vault/v1", N: 16384, r: 8, p: 1, keylen: 32 };
const AAD = Buffer.from("foundry-vault/v1");
const IV_LEN = 12;

export class Vault {
  private readonly key: Buffer;

  // Public constructor for tests/tools that hold an explicit master secret;
  // runtime code should use fromEnv().
  constructor(masterSecret: string) {
    if (masterSecret.trim() === "") throw new VaultNotConfiguredError();
    this.key = scryptSync(masterSecret, KDF.salt, KDF.keylen, {
      N: KDF.N,
      r: KDF.r,
      p: KDF.p,
    });
  }

  /**
   * Build a Vault from the env var. Errors if FOUNDRY_MASTER_KEY is missing or
   * blank — per build-order P0 task 5, "master key from env, error if missing".
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Vault {
    const secret = env["FOUNDRY_MASTER_KEY"];
    if (secret === undefined || secret.trim() === "") throw new VaultNotConfiguredError();
    return new Vault(secret);
  }

  /** Encrypt a secret string. Fresh random IV per call (never reuse IVs). */
  encrypt(plaintext: string): VaultBlob {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv, { authTagLength: 16 });
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag() };
  }

  /** Decrypt a blob produced by encrypt(). Throws VaultDecryptError on any mismatch. */
  decrypt(blob: VaultBlob): string {
    if (blob.iv.length !== IV_LEN || blob.ciphertext.length === 0) {
      throw new VaultDecryptError("malformed blob");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, blob.iv, { authTagLength: 16 });
      decipher.setAAD(AAD);
      decipher.setAuthTag(blob.tag);
      return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]).toString("utf8");
    } catch (err) {
      throw new VaultDecryptError(
        err instanceof Error ? err.message : "unknown (wrong master key or tampered blob?)",
      );
    }
  }

  encryptJson(value: unknown): VaultBlob {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson<T>(blob: VaultBlob): T {
    return JSON.parse(this.decrypt(blob)) as T;
  }
}

/**
 * Hash for stored API keys / session tokens / hmac secrets — never store or
 * compare the plaintext. This is a plain digest, not vault-encrypted: these
 * are verifier values, not secrets that must be recoverable.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** New API key with a recognizable prefix for operators. */
export function newApiKey(): string {
  return `fnd_${randomBytes(24).toString("base64url")}_${randomUUID().slice(0, 8)}`;
}