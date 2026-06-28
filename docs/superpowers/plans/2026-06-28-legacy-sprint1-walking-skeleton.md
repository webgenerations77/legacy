# Legacy Sprint 1 Walking Skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-knowledge encrypted-vault walking skeleton: register → unlock → store an encrypted item → reload → re-unlock → decrypt and display, with the server only ever holding ciphertext and an auth-verifier hash.

**Architecture:** A single Next.js (App Router, TypeScript) app. The browser derives a master key from the user's passphrase via PBKDF2 and encrypts vault items with AES-GCM before sending them; the server (Prisma → Railway Postgres) stores opaque ciphertext plus a bcrypt hash of a one-way-derived auth verifier. The master key never leaves the browser and lives only in React memory.

**Tech Stack:** Next.js 15 (App Router) · React 19 · TypeScript (strict) · Prisma 6 · PostgreSQL (Railway) · WebCrypto (PBKDF2 + AES-GCM) · bcryptjs · Vitest.

## Global Constraints

- **Zero-knowledge:** the server must never receive plaintext vault data, the passphrase, or the master key. Only ciphertext, IVs, salts, and `bcrypt(authVerifier)` may be persisted.
- **KDF:** PBKDF2-HMAC-SHA256, **600,000 iterations**, 256-bit output. Salt is 128-bit random per user.
- **Auth verifier:** `authVerifier = PBKDF2(masterKey, passphrase, iterations=1, SHA-256, 256-bit)`, sent base64; server stores only `bcrypt(authVerifier)`.
- **AES-GCM:** fresh random **96-bit IV** per item; master key is the 256-bit AES key.
- **TypeScript strict** everywhere. No `any` in committed code.
- **Crypto module must be isomorphic** — identical code runs in the browser and in Node test runner (use WebCrypto globals + `atob`/`btoa`, never `Buffer`).
- **Secrets** (`DATABASE_URL`, `SESSION_*`) live in `.env` (gitignored). `.env.example` holds placeholders only.
- **Commit message footer** on every commit:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Calm UI copy** per `03_UI_UX_Design_System.md`: supportive, non-alarming; soft neutrals / warm grays / subtle-blue accents.

---

## File Structure

```
package.json                      # deps + scripts
next.config.ts
tsconfig.json
vitest.config.ts
.env.example                      # placeholders only
prisma/schema.prisma              # User, Session, VaultItem
src/lib/crypto.ts                 # isomorphic: derive/encrypt/decrypt (TDD core)
src/lib/crypto.test.ts            # crypto unit tests
src/lib/db.ts                     # Prisma client singleton
src/lib/auth.ts                   # bcrypt verifier + session create/validate
src/lib/auth.test.ts             # auth/session integration tests (TEST_DATABASE_URL)
src/lib/session-cookie.ts         # cookie name + read/write helpers
src/lib/api-client.ts             # client fetch wrappers (typed)
src/app/api/auth/register/route.ts
src/app/api/auth/salt/route.ts
src/app/api/auth/login/route.ts
src/app/api/auth/logout/route.ts
src/app/api/vault/route.ts        # GET list + POST create
src/app/providers/KeyProvider.tsx # in-memory master key context
src/app/layout.tsx                # wraps app in KeyProvider, global css
src/app/globals.css               # design tokens + base styles
src/app/page.tsx                  # redirect → /vault or /unlock
src/app/register/page.tsx
src/app/unlock/page.tsx
src/app/vault/page.tsx            # gated; list + add item
```

**Boundaries:** `crypto.ts` depends only on WebCrypto and is pure/isomorphic. `auth.ts`/`db.ts` are server-only (Prisma, bcrypt). Route handlers are the HTTP surface. `KeyProvider` is the only place the master key lives on the client. Pages consume `KeyProvider` + `api-client`.

---

## Task 1: Scaffold the Next.js + Prisma project

**Files:**
- Create: `package.json`, `next.config.ts`, `tsconfig.json`, `.env.example`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`
- Create: `vitest.config.ts`, `vitest.setup.ts`, `src/lib/session-cookie.ts`

**Interfaces:**
- Produces: a runnable Next.js app (`npm run dev`), a working test runner (`npm test`) that loads `.env.test`, `SESSION_COOKIE` from `@/lib/session-cookie`, and npm scripts later tasks rely on.

- [ ] **Step 1: Scaffold the app non-interactively**

Run from the project root (`C:\Users\webge\OneDrive\Desktop\Legacy`):

```bash
npx --yes create-next-app@latest . --typescript --app --src-dir --no-tailwind --eslint --import-alias "@/*" --use-npm --no-turbopack
```

If create-next-app refuses because the directory is non-empty, scaffold into a temp dir and move files in:

```bash
npx --yes create-next-app@latest ./_scaffold --typescript --app --src-dir --no-tailwind --eslint --import-alias "@/*" --use-npm --no-turbopack
cp -r ./_scaffold/. ./ && rm -rf ./_scaffold
```

Expected: `src/app/`, `package.json`, `tsconfig.json`, `next.config.ts` exist. The scaffolder must not overwrite the existing `.gitignore`, `docs/`, or `.claude/`.

- [ ] **Step 2: Add runtime + dev dependencies**

```bash
npm install prisma @prisma/client bcryptjs
npm install -D vitest @types/bcryptjs dotenv dotenv-cli
```

Expected: all install without errors; `@prisma/client`, `bcryptjs`, `vitest`, `dotenv`, `dotenv-cli` appear in `package.json`.

- [ ] **Step 3: Add the test script and confirm strict TS**

Edit `package.json` `"scripts"` to include:

```json
"test": "vitest run",
"test:watch": "vitest"
```

Confirm `tsconfig.json` has `"strict": true` (create-next-app sets this by default; if absent, add it under `compilerOptions`).

- [ ] **Step 4: Create the Vitest config + setup (Node env; loads `.env.test` so DB tests never touch the dev database)**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
});
```

Create `vitest.setup.ts` (loads the test database connection; harmless for the DB-less crypto tests):

```ts
import { config } from "dotenv";
config({ path: ".env.test" });
```

- [ ] **Step 4b: Create the session-cookie helper (needed by `page.tsx` below)**

Create `src/lib/session-cookie.ts`:

```ts
export const SESSION_COOKIE = "legacy_session";

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  };
}
```

- [ ] **Step 5: Replace the default page with a redirect, and add design tokens**

Replace `src/app/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/session-cookie";

export default async function Home() {
  const hasSession = (await cookies()).has(SESSION_COOKIE);
  redirect(hasSession ? "/vault" : "/unlock");
}
```

Replace `src/app/globals.css`:

```css
:root {
  --bg: #f7f6f3;          /* soft neutral */
  --surface: #ffffff;
  --text: #2b2b29;        /* warm near-black */
  --muted: #6f6c66;       /* warm gray */
  --accent: #4a6fa5;      /* subtle blue */
  --accent-weak: #e8eef6;
  --danger: #b4524a;      /* reserved for alerts only */
  --radius: 12px;
  --border: #e7e4de;
}
* { box-sizing: border-box; }
html, body { padding: 0; margin: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  line-height: 1.5;
}
.center { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 32px; width: 100%; max-width: 420px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}
h1 { font-size: 1.5rem; margin: 0 0 4px; }
.subtle { color: var(--muted); font-size: 0.95rem; margin: 0 0 20px; }
label { display: block; font-size: 0.85rem; color: var(--muted); margin: 14px 0 6px; }
input {
  width: 100%; padding: 10px 12px; border: 1px solid var(--border);
  border-radius: 8px; font-size: 1rem; background: #fff; color: var(--text);
}
button {
  margin-top: 20px; width: 100%; padding: 11px; border: 0; border-radius: 8px;
  background: var(--accent); color: #fff; font-size: 1rem; cursor: pointer;
}
button:disabled { opacity: 0.6; cursor: default; }
.link { margin-top: 16px; text-align: center; font-size: 0.9rem; }
.link a { color: var(--accent); text-decoration: none; }
.error { color: var(--danger); font-size: 0.9rem; margin-top: 12px; }
.item { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-top: 10px; background: #fff; }
.row { display: flex; gap: 8px; }
.row input { flex: 1; }
.row button { margin-top: 0; width: auto; padding: 11px 18px; }
```

- [ ] **Step 6: Verify it builds and the test runner works**

```bash
npm run build 2>&1 | tail -20
```

Expected: build succeeds (`page.tsx`'s import of `@/lib/session-cookie` now resolves; the page is dynamic because it reads cookies). Then:

```bash
npm test
```

Expected: Vitest runs and reports "no test files found" (no tests yet) — the runner itself works.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold next.js app with prisma, vitest, design tokens

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Prisma schema, Railway connection, and client singleton

**Files:**
- Create: `prisma/schema.prisma`, `src/lib/db.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `prisma` client singleton exported from `@/lib/db` as `prisma`; tables `User`, `Session`, `VaultItem` (fields per spec §4).

- [ ] **Step 1: Initialize Prisma for Postgres**

```bash
npx prisma init --datasource-provider postgresql
```

This creates `prisma/schema.prisma` and appends `DATABASE_URL` to `.env`.

- [ ] **Step 2: Write the schema**

Replace `prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id               String      @id @default(cuid())
  email            String      @unique
  kdfSalt          String
  authVerifierHash String
  createdAt        DateTime    @default(now())
  sessions         Session[]
  vaultItems       VaultItem[]
}

model Session {
  id        String   @id @default(cuid())
  userId    String
  expiresAt DateTime
  createdAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model VaultItem {
  id         String   @id @default(cuid())
  userId     String
  ciphertext String
  iv         String
  createdAt  DateTime @default(now())
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

- [ ] **Step 3: Set the connection strings (dev + test) and harden `.gitignore`**

Confirm `.env` contains a real Railway connection string. If a Railway Postgres instance does not exist yet, provision one (interactively): `! railway login` then `! railway add` (select PostgreSQL), then copy its `DATABASE_URL` into `.env`.

Create `.env.test` with a `DATABASE_URL` pointing at a **separate** database (a second Railway Postgres, or a local one) — tests load this file, so they never touch the dev database:

```
DATABASE_URL="postgresql://user:password@host:port/dbname_test"
SESSION_TTL_HOURS="12"
```

Set `.env` (dev) to:

```
DATABASE_URL="postgresql://user:password@host:port/dbname"
SESSION_TTL_HOURS="12"
```

Update `.gitignore` so every env file is ignored except the example — replace the existing env block with:

```
# Environment / secrets
.env*
!.env.example
```

Update `.env.example` (placeholders only):

```
DATABASE_URL="postgresql://user:password@host:port/dbname"
SESSION_TTL_HOURS="12"
```

- [ ] **Step 4: Create the migration against the dev database**

```bash
npx prisma migrate dev --name init
```

Expected: migration applied; `prisma/migrations/<timestamp>_init/` created; "Your database is now in sync."

- [ ] **Step 5: Create the Prisma client singleton**

Create `src/lib/db.ts`:

```ts
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```

- [ ] **Step 6: Verify the client generates and connects**

```bash
npx prisma generate && node -e "const{prisma}=require('@prisma/client');console.log('client ok')"
```

Expected: "client ok" (Prisma client generated without error).

- [ ] **Step 7: Commit**

```bash
git add prisma src/lib/db.ts .env.example
git commit -m "feat: add prisma schema (user/session/vaultitem) and db client

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Crypto core (TDD)

**Files:**
- Create: `src/lib/crypto.ts`, `src/lib/crypto.test.ts`

**Interfaces:**
- Produces (all isomorphic, browser + Node):
  - `generateSalt(): string` — base64 of 16 random bytes
  - `deriveMasterKey(passphrase: string, saltB64: string): Promise<Uint8Array>` — 32 bytes
  - `deriveAuthVerifier(masterKey: Uint8Array, passphrase: string): Promise<string>` — base64
  - `encryptItem(masterKey: Uint8Array, plaintext: string): Promise<{ ciphertext: string; iv: string }>`
  - `decryptItem(masterKey: Uint8Array, ciphertext: string, iv: string): Promise<string>`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/crypto.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/lib/crypto.test.ts
```

Expected: FAIL — cannot resolve `@/lib/crypto` (module not created yet).

- [ ] **Step 3: Implement the crypto module**

Create `src/lib/crypto.ts`:

```ts
const PBKDF2_ITERATIONS = 600_000;
const KEY_BYTES = 32; // 256-bit
const IV_BYTES = 12; // 96-bit
const SALT_BYTES = 16; // 128-bit

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array {
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
): Promise<Uint8Array> {
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
  masterKey: Uint8Array,
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

async function importAesKey(masterKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", masterKey, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptItem(
  masterKey: Uint8Array,
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
  masterKey: Uint8Array,
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
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/lib/crypto.test.ts
```

Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/crypto.ts src/lib/crypto.test.ts
git commit -m "feat: add isomorphic zero-knowledge crypto core (pbkdf2 + aes-gcm)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Server auth + session library (TDD against a test DB)

**Files:**
- Create: `src/lib/auth.ts`, `src/lib/auth.test.ts`

**Interfaces:**
- Consumes: `prisma` from `@/lib/db`. (`SESSION_COOKIE`/`sessionCookieOptions` already exist from Task 1.)
- Produces:
  - `hashVerifier(authVerifier: string): Promise<string>`
  - `verifyVerifier(authVerifier: string, hash: string): Promise<boolean>`
  - `createSession(userId: string): Promise<string>` — returns session id (cookie value)
  - `getSessionUserId(sessionId: string | undefined): Promise<string | null>` — null if missing/expired
  - `deleteSession(sessionId: string): Promise<void>`

- [ ] **Step 1: Migrate the test database (one-time)**

`.env.test` and `dotenv-cli` (from Tasks 1–2) let Prisma target the test DB without touching dev:

```bash
npx dotenv -e .env.test -- npx prisma migrate deploy
```

Expected: migrations applied to the test database ("No pending migrations" or the `init` migration applied).

- [ ] **Step 2: Write the failing tests**

Create `src/lib/auth.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import {
  hashVerifier,
  verifyVerifier,
  createSession,
  getSessionUserId,
  deleteSession,
} from "@/lib/auth";

let userId: string;

beforeAll(async () => {
  const u = await prisma.user.create({
    data: { email: `t${Date.now()}@example.com`, kdfSalt: "s", authVerifierHash: "h" },
  });
  userId = u.id;
});

afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("auth", () => {
  it("hashes and verifies an auth verifier", async () => {
    const hash = await hashVerifier("verifier-abc");
    expect(hash).not.toBe("verifier-abc");
    expect(await verifyVerifier("verifier-abc", hash)).toBe(true);
    expect(await verifyVerifier("wrong", hash)).toBe(false);
  });

  it("creates a session that resolves to the user id", async () => {
    const sid = await createSession(userId);
    expect(await getSessionUserId(sid)).toBe(userId);
  });

  it("returns null for unknown or undefined sessions", async () => {
    expect(await getSessionUserId(undefined)).toBeNull();
    expect(await getSessionUserId("does-not-exist")).toBeNull();
  });

  it("deletes a session", async () => {
    const sid = await createSession(userId);
    await deleteSession(sid);
    expect(await getSessionUserId(sid)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npx vitest run src/lib/auth.test.ts
```

(`vitest.setup.ts` loads `.env.test`, so `DATABASE_URL` points at the test DB automatically.)
Expected: FAIL — cannot resolve `@/lib/auth`.

- [ ] **Step 4: Implement the auth library**

Create `src/lib/auth.ts`:

```ts
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";

const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS ?? "12");
const BCRYPT_ROUNDS = 12;

export async function hashVerifier(authVerifier: string): Promise<string> {
  return bcrypt.hash(authVerifier, BCRYPT_ROUNDS);
}

export async function verifyVerifier(
  authVerifier: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(authVerifier, hash);
}

export async function createSession(userId: string): Promise<string> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
  const session = await prisma.session.create({ data: { userId, expiresAt } });
  return session.id;
}

export async function getSessionUserId(
  sessionId: string | undefined,
): Promise<string | null> {
  if (!sessionId) return null;
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
    return null;
  }
  return session.userId;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run src/lib/auth.test.ts
```

Expected: PASS — all 4 tests green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth.ts src/lib/auth.test.ts
git commit -m "feat: add server auth verifier hashing and session management

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Auth API routes

**Files:**
- Create: `src/app/api/auth/register/route.ts`, `src/app/api/auth/salt/route.ts`, `src/app/api/auth/login/route.ts`, `src/app/api/auth/logout/route.ts`

**Interfaces:**
- Consumes: `prisma` (`@/lib/db`), `hashVerifier`/`verifyVerifier`/`createSession`/`deleteSession` (`@/lib/auth`), `SESSION_COOKIE`/`sessionCookieOptions` (`@/lib/session-cookie`).
- Produces HTTP endpoints (spec §5):
  - `POST /api/auth/register` body `{ email, salt, authVerifier }` → 201 `{ ok: true }` | 409
  - `POST /api/auth/salt` body `{ email }` → 200 `{ salt }` | 404
  - `POST /api/auth/login` body `{ email, authVerifier }` → 200 `{ ok: true }` + Set-Cookie | 401
  - `POST /api/auth/logout` → 200, clears cookie

- [ ] **Step 1: Implement register**

Create `src/app/api/auth/register/route.ts`:

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashVerifier } from "@/lib/auth";

export async function POST(req: Request) {
  const { email, salt, authVerifier } = await req.json();
  if (!email || !salt || !authVerifier) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json(
      { error: "An account with this email already exists." },
      { status: 409 },
    );
  }
  await prisma.user.create({
    data: { email, kdfSalt: salt, authVerifierHash: await hashVerifier(authVerifier) },
  });
  return NextResponse.json({ ok: true }, { status: 201 });
}
```

- [ ] **Step 2: Implement salt lookup**

Create `src/app/api/auth/salt/route.ts`:

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST(req: Request) {
  const { email } = await req.json();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json({ salt: user.kdfSalt });
}
```

- [ ] **Step 3: Implement login**

Create `src/app/api/auth/login/route.ts`:

```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { verifyVerifier, createSession } from "@/lib/auth";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/session-cookie";

export async function POST(req: Request) {
  const { email, authVerifier } = await req.json();
  const generic = NextResponse.json(
    { error: "That email or passphrase didn't match." },
    { status: 401 },
  );
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return generic;
  if (!(await verifyVerifier(authVerifier, user.authVerifierHash))) return generic;

  const sessionId = await createSession(user.id);
  const expiresAt = new Date(
    Date.now() + Number(process.env.SESSION_TTL_HOURS ?? "12") * 3600 * 1000,
  );
  (await cookies()).set(SESSION_COOKIE, sessionId, sessionCookieOptions(expiresAt));
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Implement logout**

Create `src/app/api/auth/logout/route.ts`:

```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { deleteSession } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session-cookie";

export async function POST() {
  const jar = await cookies();
  const sid = jar.get(SESSION_COOKIE)?.value;
  if (sid) await deleteSession(sid);
  jar.delete(SESSION_COOKIE);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: Verify routes compile**

```bash
npx tsc --noEmit
```

Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/auth
git commit -m "feat: add auth api routes (register, salt, login, logout)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Vault API routes

**Files:**
- Create: `src/app/api/vault/route.ts`

**Interfaces:**
- Consumes: `prisma` (`@/lib/db`), `getSessionUserId` (`@/lib/auth`), `SESSION_COOKIE` (`@/lib/session-cookie`).
- Produces:
  - `GET /api/vault` → 200 `{ items: { id, ciphertext, iv }[] }` | 401
  - `POST /api/vault` body `{ ciphertext, iv }` → 201 `{ id }` | 400 | 401

- [ ] **Step 1: Implement the vault route handlers**

Create `src/app/api/vault/route.ts`:

```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session-cookie";

async function requireUser(): Promise<string | null> {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  return getSessionUserId(sid);
}

export async function GET() {
  const userId = await requireUser();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const items = await prisma.vaultItem.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, ciphertext: true, iv: true },
  });
  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  const userId = await requireUser();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { ciphertext, iv } = await req.json();
  if (!ciphertext || !iv) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }
  const item = await prisma.vaultItem.create({
    data: { userId, ciphertext, iv },
    select: { id: true },
  });
  return NextResponse.json({ id: item.id }, { status: 201 });
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/vault
git commit -m "feat: add vault api routes (list + create, session-gated)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Client key context + API client

**Files:**
- Create: `src/app/providers/KeyProvider.tsx`, `src/lib/api-client.ts`
- Modify: `src/app/layout.tsx`

**Interfaces:**
- Produces:
  - `KeyProvider` React component + `useKey()` hook returning `{ masterKey: Uint8Array | null; setMasterKey: (k: Uint8Array | null) => void }`
  - `api` object: `register`, `getSalt`, `login`, `logout`, `listVault`, `addVaultItem` (typed wrappers over fetch)

- [ ] **Step 1: Create the typed API client**

Create `src/lib/api-client.ts`:

```ts
async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

export const api = {
  register: (email: string, salt: string, authVerifier: string) =>
    post<{ ok: true }>("/api/auth/register", { email, salt, authVerifier }),
  getSalt: (email: string) =>
    post<{ salt: string }>("/api/auth/salt", { email }),
  login: (email: string, authVerifier: string) =>
    post<{ ok: true }>("/api/auth/login", { email, authVerifier }),
  logout: () => post<{ ok: true }>("/api/auth/logout", {}),
  listVault: async () => {
    const res = await fetch("/api/vault");
    if (!res.ok) throw new Error("Could not load your vault.");
    return res.json() as Promise<{ items: { id: string; ciphertext: string; iv: string }[] }>;
  },
  addVaultItem: (ciphertext: string, iv: string) =>
    post<{ id: string }>("/api/vault", { ciphertext, iv }),
};
```

- [ ] **Step 2: Create the KeyProvider**

Create `src/app/providers/KeyProvider.tsx`:

```tsx
"use client";

import { createContext, useContext, useState, ReactNode } from "react";

type KeyState = {
  masterKey: Uint8Array | null;
  setMasterKey: (k: Uint8Array | null) => void;
};

const KeyContext = createContext<KeyState | null>(null);

export function KeyProvider({ children }: { children: ReactNode }) {
  const [masterKey, setMasterKey] = useState<Uint8Array | null>(null);
  return (
    <KeyContext.Provider value={{ masterKey, setMasterKey }}>
      {children}
    </KeyContext.Provider>
  );
}

export function useKey(): KeyState {
  const ctx = useContext(KeyContext);
  if (!ctx) throw new Error("useKey must be used within KeyProvider");
  return ctx;
}
```

- [ ] **Step 3: Wrap the app in KeyProvider**

Replace `src/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import "./globals.css";
import { KeyProvider } from "@/app/providers/KeyProvider";

export const metadata: Metadata = {
  title: "Legacy",
  description: "Your life, organized — privately.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <KeyProvider>{children}</KeyProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 4: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/providers src/lib/api-client.ts src/app/layout.tsx
git commit -m "feat: add in-memory key context and typed api client

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Register, Unlock, and Vault pages

**Files:**
- Create: `src/app/register/page.tsx`, `src/app/unlock/page.tsx`, `src/app/vault/page.tsx`

**Interfaces:**
- Consumes: `api` (`@/lib/api-client`), `useKey` (`@/app/providers/KeyProvider`), crypto fns (`@/lib/crypto`).

- [ ] **Step 1: Build the register page**

Create `src/app/register/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api-client";
import { generateSalt, deriveMasterKey, deriveAuthVerifier } from "@/lib/crypto";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const salt = generateSalt();
      const masterKey = await deriveMasterKey(passphrase, salt);
      const authVerifier = await deriveAuthVerifier(masterKey, passphrase);
      await api.register(email, salt, authVerifier);
      router.push("/unlock");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <form className="card" onSubmit={onSubmit}>
        <h1>Create your Legacy</h1>
        <p className="subtle">Your passphrase encrypts everything. We never see it.</p>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email}
          onChange={(e) => setEmail(e.target.value)} required />
        <label htmlFor="pass">Passphrase</label>
        <input id="pass" type="password" value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)} required minLength={8} />
        <button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create account"}
        </button>
        {error && <p className="error">{error}</p>}
        <p className="link">Already have one? <Link href="/unlock">Unlock</Link></p>
      </form>
    </main>
  );
}
```

- [ ] **Step 2: Build the unlock page**

Create `src/app/unlock/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api-client";
import { useKey } from "@/app/providers/KeyProvider";
import { deriveMasterKey, deriveAuthVerifier } from "@/lib/crypto";

export default function UnlockPage() {
  const router = useRouter();
  const { setMasterKey } = useKey();
  const [email, setEmail] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { salt } = await api.getSalt(email).catch(() => {
        throw new Error("That email or passphrase didn't match.");
      });
      const masterKey = await deriveMasterKey(passphrase, salt);
      const authVerifier = await deriveAuthVerifier(masterKey, passphrase);
      await api.login(email, authVerifier);
      setMasterKey(masterKey);
      router.push("/vault");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <form className="card" onSubmit={onSubmit}>
        <h1>Welcome back</h1>
        <p className="subtle">Enter your passphrase to unlock your vault.</p>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email}
          onChange={(e) => setEmail(e.target.value)} required />
        <label htmlFor="pass">Passphrase</label>
        <input id="pass" type="password" value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)} required />
        <button type="submit" disabled={busy}>
          {busy ? "Unlocking…" : "Unlock"}
        </button>
        {error && <p className="error">{error}</p>}
        <p className="link">New here? <Link href="/register">Create your Legacy</Link></p>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Build the vault page**

Create `src/app/vault/page.tsx`:

```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { useKey } from "@/app/providers/KeyProvider";
import { encryptItem, decryptItem } from "@/lib/crypto";

export default function VaultPage() {
  const router = useRouter();
  const { masterKey, setMasterKey } = useKey();
  const [items, setItems] = useState<{ id: string; text: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!masterKey) return;
    const { items: raw } = await api.listVault();
    const decrypted = await Promise.all(
      raw.map(async (it) => {
        try {
          return { id: it.id, text: await decryptItem(masterKey, it.ciphertext, it.iv) };
        } catch {
          return { id: it.id, text: "⚠ We couldn't unlock this item." };
        }
      }),
    );
    setItems(decrypted);
    setLoaded(true);
  }, [masterKey]);

  useEffect(() => {
    if (!masterKey) {
      router.replace("/unlock");
      return;
    }
    load();
  }, [masterKey, load, router]);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!masterKey || !draft.trim()) return;
    setError("");
    try {
      const { ciphertext, iv } = await encryptItem(masterKey, draft.trim());
      await api.addVaultItem(ciphertext, iv);
      setDraft("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    }
  }

  async function onLogout() {
    await api.logout();
    setMasterKey(null);
    router.replace("/unlock");
  }

  if (!masterKey) return null;

  return (
    <main className="center">
      <div className="card">
        <h1>Your Vault</h1>
        <p className="subtle">Everything here is encrypted on your device.</p>
        <form className="row" onSubmit={onAdd}>
          <input value={draft} placeholder="Add a private note…"
            onChange={(e) => setDraft(e.target.value)} />
          <button type="submit">Add</button>
        </form>
        {error && <p className="error">{error}</p>}
        {loaded && items.length === 0 && <p className="subtle">Nothing yet. Add your first note.</p>}
        {items.map((it) => (
          <div className="item" key={it.id}>{it.text}</div>
        ))}
        <p className="link"><a onClick={onLogout} style={{ cursor: "pointer" }}>Lock & sign out</a></p>
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Verify the whole app builds**

```bash
npx tsc --noEmit && npm run build 2>&1 | tail -15
```

Expected: type-check clean; build succeeds (all routes compiled).

- [ ] **Step 5: Commit**

```bash
git add src/app/register src/app/unlock src/app/vault
git commit -m "feat: add register, unlock, and vault pages

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: End-to-end walking-skeleton verification

**Files:** none (verification only)

**Interfaces:** exercises the full stack.

- [ ] **Step 1: Run the full automated test suite**

```bash
npx vitest run
```

(`vitest.setup.ts` loads `.env.test`; the auth tests use the test DB, the crypto tests need no DB.)
Expected: all crypto + auth tests pass.

- [ ] **Step 2: Start the dev server**

```bash
npm run dev
```

Expected: server on http://localhost:3000.

- [ ] **Step 3: Manual walking-skeleton check (use the `/run` skill / browser)**

Perform in the browser:
1. Visit `/` → redirected to `/unlock`.
2. Go to `/register`, create account `walkthrough@example.com` + passphrase `test-passphrase-123` → redirected to `/unlock`.
3. Unlock with the same credentials → land on `/vault`.
4. Add a note: "My safe deposit box is at First National, key in the desk drawer." → it appears decrypted.
5. **Reload the page** → redirected to `/unlock` (master key was in memory only — the core proof).
6. Unlock again → the note reappears, correctly decrypted.

- [ ] **Step 4: Confirm zero-knowledge at the database**

```bash
npx prisma studio
```

Open the `VaultItem` table. Expected: `ciphertext` is unreadable base64; **no plaintext note text anywhere**. `User.authVerifierHash` is a bcrypt hash, not the verifier.

- [ ] **Step 5: Final commit (lockfile / any cleanup)**

```bash
git add -A
git commit -m "chore: sprint 1 walking skeleton verified end-to-end

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push
```

---

## Notes for the implementer

- **Windows shell:** commands are shown for the Bash tool (POSIX). `npx dotenv -e .env.test -- ...` is cross-platform and works in PowerShell too.
- **Test DB:** `auth.test.ts` writes to a real database. The connection comes from `.env.test` (loaded by `vitest.setup.ts`), which must point at a database **separate** from dev/prod. Run `npx dotenv -e .env.test -- npx prisma migrate deploy` once before the first auth test run (Task 4, Step 1).
- **Deferred (do NOT add now):** Argon2id, account-enumeration hardening, recovery keys, rate limiting, CSRF, passkeys (spec §6).
- **Master key lifetime:** intentionally memory-only. Losing it on refresh and re-unlocking is correct behavior, not a bug.
