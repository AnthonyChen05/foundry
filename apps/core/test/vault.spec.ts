import { describe, expect, it } from "vitest";
import {
  Vault,
  VaultDecryptError,
  VaultNotConfiguredError,
  hashToken,
  newApiKey,
} from "../src/vault/vault.js";

describe("vault", () => {
  it("roundtrips a secret string", () => {
    const vault = new Vault("correct horse battery staple");
    const blob = vault.encrypt("sk-provider-key-123");
    expect(blob.iv.length).toBe(12);
    expect(blob.tag.length).toBe(16);
    expect(blob.ciphertext.toString("utf8")).not.toContain("sk-provider-key-123");
    expect(vault.decrypt(blob)).toBe("sk-provider-key-123");
  });

  it("roundtrips JSON values", () => {
    const vault = new Vault("k");
    const blob = vault.encryptJson({ apiKey: "secret", extra: [1, 2] });
    expect(vault.decryptJson<{ apiKey: string }>(blob).apiKey).toBe("secret");
  });

  it("uses a fresh IV per encryption call", () => {
    const vault = new Vault("k");
    const a = vault.encrypt("same plaintext");
    const b = vault.encrypt("same plaintext");
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("fails with the wrong master key (auth tag mismatch)", () => {
    const a = new Vault("key-one").encrypt("payload");
    expect(() => new Vault("key-two").decrypt(a)).toThrow(VaultDecryptError);
  });

  it("detects tampering", () => {
    const vault = new Vault("k");
    const blob = vault.encrypt("payload");
    const tampered = {
      ...blob,
      ciphertext: Buffer.concat([blob.ciphertext, Buffer.from("x")]),
    };
    expect(() => vault.decrypt(tampered)).toThrow(VaultDecryptError);
    const flippedTag = {
      ...blob,
      tag: Buffer.from(blob.tag.map((b: number) => b ^ 0x01)),
    };
    expect(() => vault.decrypt(flippedTag)).toThrow(VaultDecryptError);
  });

  it("errors if the master key is missing (fromEnv)", () => {
    expect(() => Vault.fromEnv({})).toThrow(VaultNotConfiguredError);
  });

  it("errors if the master key is blank", () => {
    expect(() => Vault.fromEnv({ FOUNDRY_MASTER_KEY: "   " })).toThrow(VaultNotConfiguredError);
    expect(() => new Vault("   ")).toThrow(VaultNotConfiguredError);
  });

  it("rejects malformed blobs without leaking", () => {
    const vault = new Vault("k");
    expect(() =>
      vault.decrypt({ ciphertext: Buffer.alloc(0), iv: Buffer.alloc(12), tag: Buffer.alloc(16) }),
    ).toThrow(VaultDecryptError);
  });

  it("hashes tokens and mints prefixed api keys", () => {
    expect(hashToken("x")).toBe(hashToken("x"));
    expect(hashToken("x")).not.toBe(hashToken("y"));
    expect(newApiKey()).toMatch(/^fnd_/);
    expect(newApiKey()).not.toBe(newApiKey());
  });
});