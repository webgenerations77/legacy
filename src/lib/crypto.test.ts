import { describe, it, expect } from "vitest";
import {
  generateSalt,
  deriveMasterKey,
  deriveAuthVerifier,
  encryptItem,
  decryptItem,
} from "@/lib/crypto";

describe("crypto core", () => {
  it("encrypts then decrypts back to the original plaintext", async () => {
    const salt = generateSalt();
    const key = await deriveMasterKey("correct horse battery", salt);
    const { ciphertext, iv } = await encryptItem(key, "my secret note");
    const out = await decryptItem(key, ciphertext, iv);
    expect(out).toBe("my secret note");
  });

  it("produces different ciphertext each time (random IV)", async () => {
    const key = await deriveMasterKey("pw", generateSalt());
    const a = await encryptItem(key, "same");
    const b = await encryptItem(key, "same");
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("fails to decrypt with the wrong passphrase", async () => {
    const salt = generateSalt();
    const good = await deriveMasterKey("right-pass", salt);
    const bad = await deriveMasterKey("wrong-pass", salt);
    const { ciphertext, iv } = await encryptItem(good, "secret");
    await expect(decryptItem(bad, ciphertext, iv)).rejects.toBeDefined();
  });

  it("throws on tampered ciphertext", async () => {
    const key = await deriveMasterKey("pw", generateSalt());
    const { ciphertext, iv } = await encryptItem(key, "secret");
    const tampered = ciphertext.slice(0, -2) + (ciphertext.endsWith("A") ? "B" : "A") + "=";
    await expect(decryptItem(key, tampered, iv)).rejects.toBeDefined();
  });

  it("auth verifier is deterministic for the same inputs and differs across passphrases", async () => {
    const salt = generateSalt();
    const k1 = await deriveMasterKey("pw-one", salt);
    const k2 = await deriveMasterKey("pw-two", salt);
    const v1a = await deriveAuthVerifier(k1, "pw-one");
    const v1b = await deriveAuthVerifier(k1, "pw-one");
    const v2 = await deriveAuthVerifier(k2, "pw-two");
    expect(v1a).toBe(v1b);
    expect(v1a).not.toBe(v2);
  });
});
