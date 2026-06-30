const PBKDF2_ITERATIONS = 600_000;
const KEY_BYTES = 32; // 256-bit
const IV_BYTES = 12; // 96-bit
const SALT_BYTES = 16; // 128-bit

/** A Uint8Array backed by a (non-shared) ArrayBuffer — what WebCrypto's BufferSource requires. */
export type CryptoBytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(b64: string): CryptoBytes {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Public wrappers so callers can wrap/unwrap raw key bytes as a base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  return bytesToB64(bytes);
}
export function base64ToBytes(b64: string): CryptoBytes {
  return b64ToBytes(b64);
}

function randomBytes(n: number): CryptoBytes {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function generateSalt(): string {
  return bytesToB64(randomBytes(SALT_BYTES));
}

export async function deriveMasterKey(
  passphrase: string,
  saltB64: string,
): Promise<CryptoBytes> {
  const base = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: b64ToBytes(saltB64),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    base,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function deriveAuthVerifier(
  masterKey: CryptoBytes,
  passphrase: string,
): Promise<string> {
  const base = await crypto.subtle.importKey(
    "raw",
    masterKey,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: enc.encode(passphrase),
      iterations: 1,
      hash: "SHA-256",
    },
    base,
    KEY_BYTES * 8,
  );
  return bytesToB64(new Uint8Array(bits));
}

async function importAesKey(masterKey: CryptoBytes): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", masterKey, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptItem(
  masterKey: CryptoBytes,
  plaintext: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await importAesKey(masterKey);
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext),
  );
  return { ciphertext: bytesToB64(new Uint8Array(ct)), iv: bytesToB64(iv) };
}

export async function decryptItem(
  masterKey: CryptoBytes,
  ciphertext: string,
  iv: string,
): Promise<string> {
  const key = await importAesKey(masterKey);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(iv) },
    key,
    b64ToBytes(ciphertext),
  );
  return dec.decode(pt);
}
