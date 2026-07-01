import { describe, it, expect } from "vitest";
import {
  generateSalt,
  deriveMasterKey,
  deriveAuthVerifier,
  encryptItem,
  decryptItem,
  wrapDataKey,
  unwrapDataKey,
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

import { bytesToBase64, base64ToBytes } from "./crypto";

describe("base64 helpers", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 128, 7]);
    const b64 = bytesToBase64(bytes);
    expect(typeof b64).toBe("string");
    expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes));
  });

  it("base64ToBytes is backed by a real ArrayBuffer (usable by WebCrypto)", () => {
    const out = base64ToBytes(bytesToBase64(new Uint8Array([9, 9, 9])));
    expect(out.buffer).toBeInstanceOf(ArrayBuffer);
  });
});

import { encryptBytes, decryptBytes } from "./crypto";

describe("binary encrypt/decrypt", () => {
  it("round-trips arbitrary binary bytes", async () => {
    const key = await deriveMasterKey("file-pass", generateSalt());
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 7, 13, 0, 99]);
    const { ciphertext, iv } = await encryptBytes(key, bytes);
    const out = await decryptBytes(key, ciphertext, iv);
    expect(Array.from(out)).toEqual(Array.from(bytes));
  });

  it("uses a random IV (different ciphertext each time)", async () => {
    const key = await deriveMasterKey("pw", generateSalt());
    const bytes = new Uint8Array([1, 2, 3]);
    const a = await encryptBytes(key, bytes);
    const b = await encryptBytes(key, bytes);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("fails to decrypt with the wrong key", async () => {
    const salt = generateSalt();
    const good = await deriveMasterKey("right", salt);
    const bad = await deriveMasterKey("wrong", salt);
    const { ciphertext, iv } = await encryptBytes(good, new Uint8Array([5, 6, 7]));
    await expect(decryptBytes(bad, ciphertext, iv)).rejects.toBeDefined();
  });
});

describe("wrapDataKey / unwrapDataKey", () => {
  it("round-trips a data key through a KEK", async () => {
    const kek = await deriveMasterKey("kek-pass", generateSalt());
    const dataKey = await deriveMasterKey("dk-material", generateSalt());
    const { ciphertext, iv } = await wrapDataKey(kek, dataKey);
    const back = await unwrapDataKey(kek, ciphertext, iv);
    expect(Array.from(back)).toEqual(Array.from(dataKey));
  });

  it("rejects unwrapping with the wrong KEK", async () => {
    const kek = await deriveMasterKey("kek-pass", generateSalt());
    const wrong = await deriveMasterKey("other-pass", generateSalt());
    const dataKey = await deriveMasterKey("dk-material", generateSalt());
    const { ciphertext, iv } = await wrapDataKey(kek, dataKey);
    await expect(unwrapDataKey(wrong, ciphertext, iv)).rejects.toThrow();
  });
});
