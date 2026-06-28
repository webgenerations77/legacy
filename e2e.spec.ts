// End-to-end walking-skeleton verification.
// Run against a LIVE dev server (npm run dev, dev database):
//   npx vitest run e2e.spec.ts
// Proves the full zero-knowledge loop: register -> unlock -> store encrypted ->
// list -> decrypt, plus that the database holds only ciphertext (never plaintext).
import { describe, it, expect, afterAll } from "vitest";
import { config } from "dotenv";
import { PrismaClient } from "@prisma/client";
import {
  generateSalt,
  deriveMasterKey,
  deriveAuthVerifier,
  encryptItem,
  decryptItem,
} from "@/lib/crypto";

const BASE = "http://localhost:3000";
// Inspect the DEV database directly (the server writes here). vitest.setup loads
// .env.test, so read the dev URL explicitly rather than from process.env.
const devUrl = config({ path: ".env" }).parsed?.DATABASE_URL as string;
const db = new PrismaClient({ datasources: { db: { url: devUrl } } });

const email = `e2e-${Date.now()}@example.com`;
const passphrase = "walkthrough-passphrase-123";
const secret = "My safe deposit box is at First National, key in the desk drawer.";

const json = { "content-type": "application/json" };

afterAll(async () => {
  await db.user.deleteMany({ where: { email } });
  await db.$disconnect();
});

describe("walking skeleton (live)", () => {
  it("registers, unlocks, stores encrypted, and decrypts back", async () => {
    // --- Register: derive client-side, send only salt + verifier ---
    const salt = generateSalt();
    const mk = await deriveMasterKey(passphrase, salt);
    const av = await deriveAuthVerifier(mk, passphrase);
    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email, salt, authVerifier: av }),
    });
    expect(reg.status).toBe(201);

    // --- Fresh unlock: fetch salt, re-derive (master key never persisted) ---
    const saltRes = await fetch(`${BASE}/api/auth/salt`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email }),
    });
    expect(saltRes.status).toBe(200);
    const { salt: salt2 } = await saltRes.json();
    expect(salt2).toBe(salt);
    const mk2 = await deriveMasterKey(passphrase, salt2);
    const av2 = await deriveAuthVerifier(mk2, passphrase);

    // --- Login: get session cookie ---
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email, authVerifier: av2 }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(cookie).toContain("legacy_session=");

    // --- Wrong passphrase is rejected ---
    const wrongMk = await deriveMasterKey("not-the-passphrase", salt);
    const wrongAv = await deriveAuthVerifier(wrongMk, "not-the-passphrase");
    const badLogin = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email, authVerifier: wrongAv }),
    });
    expect(badLogin.status).toBe(401);

    // --- Vault requires a session ---
    const noAuth = await fetch(`${BASE}/api/vault`);
    expect(noAuth.status).toBe(401);

    // --- Store an encrypted item ---
    const { ciphertext, iv } = await encryptItem(mk2, secret);
    const add = await fetch(`${BASE}/api/vault`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ ciphertext, iv }),
    });
    expect(add.status).toBe(201);

    // --- List and decrypt ---
    const list = await fetch(`${BASE}/api/vault`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const { items } = await list.json();
    expect(items).toHaveLength(1);
    expect(await decryptItem(mk2, items[0].ciphertext, items[0].iv)).toBe(secret);

    // --- ZERO-KNOWLEDGE: the database holds only ciphertext + a bcrypt hash ---
    const user = await db.user.findUnique({
      where: { email },
      include: { vaultItems: true },
    });
    expect(user).toBeTruthy();
    // auth verifier is stored as a bcrypt hash, not the verifier itself
    expect(user!.authVerifierHash.startsWith("$2")).toBe(true);
    expect(user!.authVerifierHash).not.toBe(av2);
    // vault item is opaque: no plaintext anywhere
    const stored = user!.vaultItems[0];
    expect(stored.ciphertext).not.toContain("safe deposit");
    expect(stored.ciphertext).not.toContain(secret);
    // ...but it still decrypts back to the original
    expect(await decryptItem(mk2, stored.ciphertext, stored.iv)).toBe(secret);
  }, 60_000);
});
