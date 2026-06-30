# Survivor Mode (Recovery-Code Escrow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a designated survivor decrypt a deceased owner's vault read-only using a one-time recovery code, without the owner's passphrase, while preserving zero-knowledge.

**Architecture:** The master key is escrowed — stored server-side as `AES-GCM(survivorKey, masterKey)` where `survivorKey = PBKDF2(recoveryCode, survivorSalt)`. The survivor recovers the *real* master key client-side and decrypts existing records untouched (no re-encryption). The flow mirrors the existing login design exactly: a `survivorKey` (unwraps the escrow, never sent) and a `survivorAuthVerifier` (bcrypt-checked server-side to release the escrow + records). Nothing new is added to the crypto core except two base64 helpers.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma 6 → Postgres, WebCrypto (PBKDF2-600k + AES-GCM), bcryptjs, Vitest.

## Global Constraints

- **Zero-knowledge invariant:** the server stores only `survivorSalt`, `bcrypt(survivorAuthVerifier)`, and opaque `escrowCiphertext`/`escrowIv`. The recovery code and master key never reach the server.
- **Reuse `src/lib/crypto.ts`** — no new crypto primitives; only expose existing base64 helpers.
- TypeScript strict; always run `npx tsc --noEmit` (Vitest does not type-check).
- Migrations are committed as files under `prisma/migrations/` and applied to **both** dev (`.env`) and test (`.env.test`) DBs.
- Domain libs are pure and unit-tested; route tests mock `next/headers`, `@/lib/auth`, `@/lib/db` (see existing `src/lib/encrypted-record-route.test.ts`).
- The live e2e (`e2e.spec.ts`) is NOT run by `npm test`; run with `npx vitest run --config vitest.e2e.config.ts` against a live `npm run dev` + dev DB.
- Reference spec: `docs/superpowers/specs/2026-06-30-survivor-mode-design.md`.

---

### Task 1: Prisma model + migration

**Files:**
- Modify: `prisma/schema.prisma` (add `SurvivorAccess` model + `User` relation)
- Create: `prisma/migrations/<timestamp>_survivor_access/migration.sql` (generated)

**Interfaces:**
- Produces: Prisma model `SurvivorAccess { id, userId (unique), survivorSalt, survivorAuthVerifierHash, escrowCiphertext, escrowIv, createdAt, updatedAt }`; `prisma.survivorAccess` delegate; `User.survivorAccess` relation.

- [ ] **Step 1: Add the model to `prisma/schema.prisma`**

Add to the `User` model's relation list (alongside `obituary`/`readinessState`):

```prisma
  survivorAccess    SurvivorAccess?
```

Append a new model at the end of the file:

```prisma
model SurvivorAccess {
  id                       String   @id @default(cuid())
  userId                   String   @unique
  survivorSalt             String
  survivorAuthVerifierHash String
  escrowCiphertext         String
  escrowIv                 String
  createdAt                DateTime @default(now())
  updatedAt                DateTime @updatedAt
  user                     User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

- [ ] **Step 2: Create + apply the migration on the dev DB**

Run (uses `.env` / `DATABASE_URL`):

```bash
npx prisma migrate dev --name survivor_access
```

Expected: a new folder `prisma/migrations/<timestamp>_survivor_access/` with `migration.sql`, and "Your database is now in sync".

- [ ] **Step 3: Apply the migration to the test DB**

Run (point Prisma at the test DB):

```bash
npx dotenv -e .env.test -- prisma migrate deploy
```

Expected: "1 migration applied" (or "No pending migrations" if already in sync). If `dotenv-cli` is unavailable, set `DATABASE_URL` from `.env.test` for this one command instead. Expected: applied with no error.

- [ ] **Step 4: Regenerate the client and typecheck**

Run:

```bash
npx prisma generate && npx tsc --noEmit
```

Expected: generates `prisma.survivorAccess`; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(survivor): SurvivorAccess model + migration"
```

---

### Task 2: Export base64 helpers from `crypto.ts`

**Files:**
- Modify: `src/lib/crypto.ts`
- Test: `src/lib/crypto.test.ts` (append)

**Interfaces:**
- Produces: `export function bytesToBase64(bytes: Uint8Array): string` and `export function base64ToBytes(b64: string): CryptoBytes`. These wrap the existing private `bytesToB64`/`b64ToBytes` so the master key can be wrapped as the AES-GCM plaintext string and recovered as bytes.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/crypto.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/crypto.test.ts`
Expected: FAIL — `bytesToBase64`/`base64ToBytes` are not exported.

- [ ] **Step 3: Export the helpers**

In `src/lib/crypto.ts`, change the two private functions to exported wrappers (keep existing internal callers working). Replace the `bytesToB64`/`b64ToBytes` definitions' visibility by adding exported aliases just after them:

```ts
/** Public wrappers so callers can wrap/unwrap raw key bytes as a base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  return bytesToB64(bytes);
}
export function base64ToBytes(b64: string): CryptoBytes {
  return b64ToBytes(b64);
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/lib/crypto.test.ts && npx tsc --noEmit`
Expected: PASS; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/crypto.ts src/lib/crypto.test.ts
git commit -m "feat(crypto): export bytesToBase64/base64ToBytes helpers"
```

---

### Task 3: Pure survivor lib (`src/lib/survivor.ts`)

**Files:**
- Create: `src/lib/survivor.ts`
- Test: `src/lib/survivor.test.ts`

**Interfaces:**
- Consumes: `bytesToBase64` from `@/lib/crypto` (Task 2).
- Produces:
  - `generateRecoveryCode(): string` — 20 Crockford-base32 chars, grouped `XXXXX-XXXXX-XXXXX-XXXXX`.
  - `normalizeRecoveryCode(input: string): string` — strip dashes/whitespace, uppercase.
  - `formatRecoveryCode(raw: string): string` — normalize then regroup into 5-char groups.
  - `decoySalt(secret: string, email: string): Promise<string>` — deterministic HMAC-SHA256 salt, base64 of 16 bytes, for unarmed emails.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/survivor.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  generateRecoveryCode,
  normalizeRecoveryCode,
  formatRecoveryCode,
  decoySalt,
} from "./survivor";

describe("recovery code", () => {
  it("generates 4 groups of 5 Crockford-base32 chars", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
  });

  it("generates distinct codes", () => {
    expect(generateRecoveryCode()).not.toBe(generateRecoveryCode());
  });

  it("normalize strips dashes/whitespace and uppercases", () => {
    expect(normalizeRecoveryCode(" k7q2m-9xtr4 ")).toBe("K7Q2M9XTR4");
  });

  it("format regroups a normalized code", () => {
    expect(formatRecoveryCode("k7q2m9xtr4abcde0fghj")).toBe("K7Q2M-9XTR4-ABCDE-0FGHJ");
  });

  it("round-trips generate -> normalize -> format", () => {
    const code = generateRecoveryCode();
    expect(formatRecoveryCode(normalizeRecoveryCode(code))).toBe(code);
  });
});

describe("decoySalt", () => {
  it("is deterministic per (secret, email)", async () => {
    const a = await decoySalt("server-secret", "person@example.com");
    const b = await decoySalt("server-secret", "person@example.com");
    expect(a).toBe(b);
  });

  it("normalizes email casing/whitespace", async () => {
    expect(await decoySalt("s", " Person@Example.com ")).toBe(
      await decoySalt("s", "person@example.com"),
    );
  });

  it("differs by email and looks like a 16-byte base64 salt", async () => {
    const a = await decoySalt("s", "a@example.com");
    const b = await decoySalt("s", "b@example.com");
    expect(a).not.toBe(b);
    // 16 bytes -> 24 base64 chars incl. padding
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/lib/survivor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/survivor.ts`**

```ts
import { bytesToBase64 } from "@/lib/crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 (no I,L,O,U)
const CODE_CHARS = 20;
const GROUP = 5;
const enc = new TextEncoder();

function group(chars: string): string {
  return chars.match(new RegExp(`.{1,${GROUP}}`, "g"))!.join("-");
}

/** ~100-bit human-friendly recovery code, e.g. "K7Q2M-9XTR4-ABCDE-0FGHJ". */
export function generateRecoveryCode(): string {
  const bytes = new Uint8Array(CODE_CHARS);
  crypto.getRandomValues(bytes);
  // 256 % 32 === 0, so (b & 31) is an unbiased index into ALPHABET.
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 31];
  return group(out);
}

export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase();
}

export function formatRecoveryCode(raw: string): string {
  return group(normalizeRecoveryCode(raw));
}

/** Deterministic decoy salt for emails with no armed survivor access. */
export async function decoySalt(secret: string, email: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(email.trim().toLowerCase()));
  return bytesToBase64(new Uint8Array(mac).slice(0, 16));
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/lib/survivor.test.ts && npx tsc --noEmit`
Expected: PASS; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/survivor.ts src/lib/survivor.test.ts
git commit -m "feat(survivor): pure recovery-code + decoy-salt lib"
```

---

### Task 4: Survivor crypto module (`src/lib/survivor-crypto.ts`)

**Files:**
- Create: `src/lib/survivor-crypto.ts`
- Test: `src/lib/survivor-crypto.test.ts`

**Interfaces:**
- Consumes: `deriveMasterKey`, `deriveAuthVerifier`, `encryptItem`, `decryptItem`, `generateSalt`, `bytesToBase64`, `base64ToBytes`, `CryptoBytes` from `@/lib/crypto`; `generateRecoveryCode`, `normalizeRecoveryCode` from `@/lib/survivor`.
- Produces:
  - `type ArmResult = { recoveryCode: string; survivorSalt: string; survivorAuthVerifier: string; escrowCiphertext: string; escrowIv: string }`.
  - `buildSurvivorEscrow(masterKey: CryptoBytes): Promise<ArmResult>` — generates a fresh code + salt and wraps the master key.
  - `deriveSurvivorAuthVerifier(recoveryCode: string, survivorSalt: string): Promise<string>` — for the claim call.
  - `recoverMasterKey(recoveryCode: string, survivorSalt: string, escrowCiphertext: string, escrowIv: string): Promise<CryptoBytes>` — unwraps the master key.

- [ ] **Step 1: Write the failing test (real WebCrypto round-trip, runs in the node test env)**

Create `src/lib/survivor-crypto.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveMasterKey, generateSalt, encryptItem, decryptItem } from "./crypto";
import {
  buildSurvivorEscrow,
  deriveSurvivorAuthVerifier,
  recoverMasterKey,
} from "./survivor-crypto";

describe("survivor crypto round-trip", () => {
  it("recovers the exact master key from the recovery code", async () => {
    const masterKey = await deriveMasterKey("owner-passphrase", generateSalt());
    const arm = await buildSurvivorEscrow(masterKey);

    const recovered = await recoverMasterKey(
      arm.recoveryCode,
      arm.survivorSalt,
      arm.escrowCiphertext,
      arm.escrowIv,
    );
    expect(Array.from(recovered)).toEqual(Array.from(masterKey));

    // the recovered key decrypts data encrypted under the original key
    const blob = await encryptItem(masterKey, "secret note");
    expect(await decryptItem(recovered, blob.ciphertext, blob.iv)).toBe("secret note");
  }, 30_000);

  it("claim verifier matches the armed verifier (and is tolerant of formatting)", async () => {
    const masterKey = await deriveMasterKey("p", generateSalt());
    const arm = await buildSurvivorEscrow(masterKey);
    const v = await deriveSurvivorAuthVerifier(arm.recoveryCode, arm.survivorSalt);
    expect(v).toBe(arm.survivorAuthVerifier);
  }, 30_000);

  it("a wrong code cannot unwrap the escrow", async () => {
    const masterKey = await deriveMasterKey("p", generateSalt());
    const arm = await buildSurvivorEscrow(masterKey);
    await expect(
      recoverMasterKey("00000-00000-00000-00000", arm.survivorSalt, arm.escrowCiphertext, arm.escrowIv),
    ).rejects.toThrow();
  }, 30_000);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/lib/survivor-crypto.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/survivor-crypto.ts`**

```ts
import {
  type CryptoBytes,
  deriveMasterKey,
  deriveAuthVerifier,
  encryptItem,
  decryptItem,
  generateSalt,
  bytesToBase64,
  base64ToBytes,
} from "@/lib/crypto";
import { generateRecoveryCode, normalizeRecoveryCode } from "@/lib/survivor";

export type ArmResult = {
  recoveryCode: string;
  survivorSalt: string;
  survivorAuthVerifier: string;
  escrowCiphertext: string;
  escrowIv: string;
};

/** Derive the survivor key from a recovery code (normalized) + salt. */
async function survivorKeyFrom(recoveryCode: string, survivorSalt: string): Promise<CryptoBytes> {
  return deriveMasterKey(normalizeRecoveryCode(recoveryCode), survivorSalt);
}

/** Owner-side: generate a code + salt and wrap the master key for escrow. */
export async function buildSurvivorEscrow(masterKey: CryptoBytes): Promise<ArmResult> {
  const recoveryCode = generateRecoveryCode();
  const survivorSalt = generateSalt();
  const survivorKey = await survivorKeyFrom(recoveryCode, survivorSalt);
  const { ciphertext, iv } = await encryptItem(survivorKey, bytesToBase64(masterKey));
  const survivorAuthVerifier = await deriveAuthVerifier(
    survivorKey,
    normalizeRecoveryCode(recoveryCode),
  );
  return {
    recoveryCode,
    survivorSalt,
    survivorAuthVerifier,
    escrowCiphertext: ciphertext,
    escrowIv: iv,
  };
}

/** Survivor-side: the verifier the server bcrypt-checks before releasing data. */
export async function deriveSurvivorAuthVerifier(
  recoveryCode: string,
  survivorSalt: string,
): Promise<string> {
  const survivorKey = await survivorKeyFrom(recoveryCode, survivorSalt);
  return deriveAuthVerifier(survivorKey, normalizeRecoveryCode(recoveryCode));
}

/** Survivor-side: unwrap the real master key from the escrow blob. */
export async function recoverMasterKey(
  recoveryCode: string,
  survivorSalt: string,
  escrowCiphertext: string,
  escrowIv: string,
): Promise<CryptoBytes> {
  const survivorKey = await survivorKeyFrom(recoveryCode, survivorSalt);
  const masterKeyB64 = await decryptItem(survivorKey, escrowCiphertext, escrowIv);
  return base64ToBytes(masterKeyB64);
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/lib/survivor-crypto.test.ts && npx tsc --noEmit`
Expected: PASS; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/survivor-crypto.ts src/lib/survivor-crypto.test.ts
git commit -m "feat(survivor): client escrow/recover crypto module"
```

---

### Task 5: Arm/status/revoke route (`/api/survivor`)

**Files:**
- Create: `src/app/api/survivor/route.ts`
- Test: `src/app/api/survivor/route.test.ts`

**Interfaces:**
- Consumes: `requireUserId` from `@/lib/route-auth`; `hashVerifier` from `@/lib/auth`; `prisma.survivorAccess` (Task 1); `readJsonBody` from `@/lib/http`.
- Produces:
  - `POST /api/survivor` body `{ survivorSalt, survivorAuthVerifier, escrowCiphertext, escrowIv }` → `{ ok: true }` (201); upserts by `userId`.
  - `GET /api/survivor` → `{ armed: boolean, updatedAt: string | null }`.
  - `DELETE /api/survivor` → `{ ok: true }`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/survivor/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUserId = vi.fn();
const findUnique = vi.fn();
const upsert = vi.fn();
const deleteMany = vi.fn();

vi.mock("@/lib/route-auth", () => ({ requireUserId: () => requireUserId() }));
vi.mock("@/lib/auth", () => ({ hashVerifier: async (v: string) => `hash:${v}` }));
vi.mock("@/lib/db", () => ({
  prisma: {
    survivorAccess: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      upsert: (...a: unknown[]) => upsert(...a),
      deleteMany: (...a: unknown[]) => deleteMany(...a),
    },
  },
}));

import { GET, POST, DELETE } from "./route";

function postReq(body: unknown) {
  return new Request("http://localhost/api/survivor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const armBody = {
  survivorSalt: "s",
  survivorAuthVerifier: "v",
  escrowCiphertext: "c",
  escrowIv: "i",
};

beforeEach(() => {
  requireUserId.mockReset();
  findUnique.mockReset();
  upsert.mockReset();
  deleteMany.mockReset();
});

describe("/api/survivor", () => {
  it("POST 401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await POST(postReq(armBody))).status).toBe(401);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("POST 400 when a field is missing", async () => {
    requireUserId.mockResolvedValue("u1");
    expect((await POST(postReq({ survivorSalt: "s" }))).status).toBe(400);
  });

  it("POST upserts and hashes the verifier", async () => {
    requireUserId.mockResolvedValue("u1");
    upsert.mockResolvedValue({ id: "sa1" });
    const res = await POST(postReq(armBody));
    expect(res.status).toBe(201);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1" },
        create: expect.objectContaining({ userId: "u1", survivorAuthVerifierHash: "hash:v" }),
        update: expect.objectContaining({ survivorAuthVerifierHash: "hash:v" }),
      }),
    );
  });

  it("GET reports armed state", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ updatedAt: new Date("2026-06-30T00:00:00Z") });
    expect(await (await GET()).json()).toEqual({
      armed: true,
      updatedAt: "2026-06-30T00:00:00.000Z",
    });
    findUnique.mockResolvedValue(null);
    expect(await (await GET()).json()).toEqual({ armed: false, updatedAt: null });
  });

  it("DELETE revokes", async () => {
    requireUserId.mockResolvedValue("u1");
    deleteMany.mockResolvedValue({ count: 1 });
    expect((await DELETE()).status).toBe(200);
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/app/api/survivor/route.test.ts`
Expected: FAIL — `./route` not found.

- [ ] **Step 3: Implement `src/app/api/survivor/route.ts`**

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/route-auth";
import { hashVerifier } from "@/lib/auth";
import { readJsonBody } from "@/lib/http";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const row = await prisma.survivorAccess.findUnique({
    where: { userId },
    select: { updatedAt: true },
  });
  return NextResponse.json({
    armed: !!row,
    updatedAt: row ? row.updatedAt.toISOString() : null,
  });
}

export async function POST(req: Request) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;

  const survivorSalt = typeof body.survivorSalt === "string" ? body.survivorSalt : "";
  const survivorAuthVerifier =
    typeof body.survivorAuthVerifier === "string" ? body.survivorAuthVerifier : "";
  const escrowCiphertext = typeof body.escrowCiphertext === "string" ? body.escrowCiphertext : "";
  const escrowIv = typeof body.escrowIv === "string" ? body.escrowIv : "";
  if (!survivorSalt || !survivorAuthVerifier || !escrowCiphertext || !escrowIv) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }

  const survivorAuthVerifierHash = await hashVerifier(survivorAuthVerifier);
  await prisma.survivorAccess.upsert({
    where: { userId },
    create: { userId, survivorSalt, survivorAuthVerifierHash, escrowCiphertext, escrowIv },
    update: { survivorSalt, survivorAuthVerifierHash, escrowCiphertext, escrowIv },
  });
  return NextResponse.json({ ok: true }, { status: 201 });
}

export async function DELETE() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  await prisma.survivorAccess.deleteMany({ where: { userId } });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/app/api/survivor/route.test.ts && npx tsc --noEmit`
Expected: PASS; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/survivor/route.ts src/app/api/survivor/route.test.ts
git commit -m "feat(survivor): arm/status/revoke route"
```

---

### Task 6: Salt route (`/api/survivor/salt`) + env secret

**Files:**
- Create: `src/app/api/survivor/salt/route.ts`
- Test: `src/app/api/survivor/salt/route.test.ts`
- Modify: `.env`, `.env.test` (add `SURVIVOR_SALT_SECRET`)

**Interfaces:**
- Consumes: `prisma.user` (relation `survivorAccess`); `decoySalt` from `@/lib/survivor`; `readJsonBody`.
- Produces: `POST /api/survivor/salt` body `{ email }` → `{ salt }` (real if armed, deterministic decoy otherwise; never 404).

- [ ] **Step 1: Add the env secret to both env files**

Generate a value:

```bash
node -e "console.log('SURVIVOR_SALT_SECRET=' + require('crypto').randomBytes(32).toString('base64'))"
```

Append the printed line to both `.env` and `.env.test` (each may use a different value; the dev and test DBs are independent).

- [ ] **Step 2: Write the failing test**

Create `src/app/api/survivor/salt/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

import { POST } from "./route";
import { decoySalt } from "@/lib/survivor";

process.env.SURVIVOR_SALT_SECRET = "test-secret";

function req(body: unknown) {
  return new Request("http://localhost/api/survivor/salt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => findUnique.mockReset());

describe("/api/survivor/salt", () => {
  it("returns the real salt when armed", async () => {
    findUnique.mockResolvedValue({ survivorAccess: { survivorSalt: "REAL_SALT" } });
    const res = await POST(req({ email: "a@example.com" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ salt: "REAL_SALT" });
  });

  it("returns a deterministic decoy salt (not 404) when unarmed", async () => {
    findUnique.mockResolvedValue({ survivorAccess: null });
    const res = await POST(req({ email: "a@example.com" }));
    expect(res.status).toBe(200);
    expect((await res.json()).salt).toBe(await decoySalt("test-secret", "a@example.com"));
  });

  it("returns a decoy for an unknown user too", async () => {
    findUnique.mockResolvedValue(null);
    const res = await POST(req({ email: "ghost@example.com" }));
    expect(res.status).toBe(200);
    expect((await res.json()).salt).toBe(await decoySalt("test-secret", "ghost@example.com"));
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `npx vitest run src/app/api/survivor/salt/route.test.ts`
Expected: FAIL — `./route` not found.

- [ ] **Step 4: Implement `src/app/api/survivor/salt/route.ts`**

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { readJsonBody } from "@/lib/http";
import { decoySalt } from "@/lib/survivor";

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const secret = process.env.SURVIVOR_SALT_SECRET ?? "";

  const user = email
    ? await prisma.user.findUnique({
        where: { email },
        select: { survivorAccess: { select: { survivorSalt: true } } },
      })
    : null;

  const salt = user?.survivorAccess?.survivorSalt ?? (await decoySalt(secret, email));
  return NextResponse.json({ salt });
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/app/api/survivor/salt/route.test.ts && npx tsc --noEmit`
Expected: PASS; `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/survivor/salt/route.ts src/app/api/survivor/salt/route.test.ts
git commit -m "feat(survivor): salt route with anti-enumeration decoy"
```

(`.env`/`.env.test` are gitignored — not committed. Note the new var in the manual checklist in Task 11.)

---

### Task 7: Claim route (`/api/survivor/claim`)

**Files:**
- Create: `src/app/api/survivor/claim/route.ts`
- Test: `src/app/api/survivor/claim/route.test.ts`

**Interfaces:**
- Consumes: `prisma.user` (with record relations + `survivorAccess`); `verifyVerifier` from `@/lib/auth`; `readJsonBody`.
- Produces: `POST /api/survivor/claim` body `{ email, survivorAuthVerifier }` → on success `{ escrow: { ciphertext, iv }, records: { items, accounts, bills, loans, beneficiaries, obituary } }`; on any failure → `401 { error: "Could not unlock." }`. `items/accounts/bills/loans/beneficiaries` are `{ id, ciphertext, iv }[]`; `obituary` is `{ intake, draft } | null`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/survivor/claim/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const verifyVerifier = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));
vi.mock("@/lib/auth", () => ({
  verifyVerifier: (...a: unknown[]) => verifyVerifier(...a),
}));

import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://localhost/api/survivor/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const userRow = {
  survivorAccess: {
    survivorAuthVerifierHash: "hash",
    escrowCiphertext: "EC",
    escrowIv: "EI",
  },
  vaultItems: [{ id: "v1", ciphertext: "vc", iv: "vi" }],
  financialAccounts: [{ id: "a1", ciphertext: "ac", iv: "ai" }],
  bills: [],
  loans: [],
  beneficiaries: [],
  obituary: { intake: { subjectName: "X" }, draft: "An obituary" },
};

beforeEach(() => {
  findUnique.mockReset();
  verifyVerifier.mockReset();
});

describe("/api/survivor/claim", () => {
  it("401 when no survivor access for that email", async () => {
    findUnique.mockResolvedValue(null);
    expect((await POST(req({ email: "a@b.com", survivorAuthVerifier: "v" }))).status).toBe(401);
  });

  it("401 when the verifier does not match", async () => {
    findUnique.mockResolvedValue(userRow);
    verifyVerifier.mockResolvedValue(false);
    const res = await POST(req({ email: "a@b.com", survivorAuthVerifier: "wrong" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Could not unlock." });
  });

  it("returns escrow + all records on a correct verifier", async () => {
    findUnique.mockResolvedValue(userRow);
    verifyVerifier.mockResolvedValue(true);
    const res = await POST(req({ email: "a@b.com", survivorAuthVerifier: "right" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      escrow: { ciphertext: "EC", iv: "EI" },
      records: {
        items: [{ id: "v1", ciphertext: "vc", iv: "vi" }],
        accounts: [{ id: "a1", ciphertext: "ac", iv: "ai" }],
        bills: [],
        loans: [],
        beneficiaries: [],
        obituary: { intake: { subjectName: "X" }, draft: "An obituary" },
      },
    });
    expect(verifyVerifier).toHaveBeenCalledWith("right", "hash");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/app/api/survivor/claim/route.test.ts`
Expected: FAIL — `./route` not found.

- [ ] **Step 3: Implement `src/app/api/survivor/claim/route.ts`**

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyVerifier } from "@/lib/auth";
import { readJsonBody } from "@/lib/http";

const DENIED = NextResponse.json({ error: "Could not unlock." }, { status: 401 });
const blobSelect = { select: { id: true, ciphertext: true, iv: true }, orderBy: { createdAt: "desc" } } as const;

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const survivorAuthVerifier =
    typeof body.survivorAuthVerifier === "string" ? body.survivorAuthVerifier : "";
  if (!email || !survivorAuthVerifier) {
    return NextResponse.json({ error: "Could not unlock." }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      survivorAccess: true,
      vaultItems: blobSelect,
      financialAccounts: blobSelect,
      bills: blobSelect,
      loans: blobSelect,
      beneficiaries: blobSelect,
      obituary: { select: { intake: true, draft: true } },
    },
  });

  if (!user || !user.survivorAccess) return DENIED;
  const ok = await verifyVerifier(survivorAuthVerifier, user.survivorAccess.survivorAuthVerifierHash);
  if (!ok) return DENIED;

  return NextResponse.json({
    escrow: {
      ciphertext: user.survivorAccess.escrowCiphertext,
      iv: user.survivorAccess.escrowIv,
    },
    records: {
      items: user.vaultItems,
      accounts: user.financialAccounts,
      bills: user.bills,
      loans: user.loans,
      beneficiaries: user.beneficiaries,
      obituary: user.obituary,
    },
  });
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/app/api/survivor/claim/route.test.ts && npx tsc --noEmit`
Expected: PASS; `tsc` exits 0. (If Prisma's `include`+`orderBy` typing complains about the shared `blobSelect` const, inline the `{ select, orderBy }` object per relation.)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/survivor/claim/route.ts src/app/api/survivor/claim/route.test.ts
git commit -m "feat(survivor): claim route releases escrow + records on verifier match"
```

---

### Task 8: api-client survivor methods

**Files:**
- Modify: `src/lib/api-client.ts`

**Interfaces:**
- Consumes: routes from Tasks 5–7.
- Produces, added to the `api` object:
  - `survivorStatus(): Promise<{ armed: boolean; updatedAt: string | null }>`
  - `armSurvivor(payload: { survivorSalt; survivorAuthVerifier; escrowCiphertext; escrowIv }): Promise<{ ok: true }>`
  - `revokeSurvivor(): Promise<{ ok: true }>`
  - `survivorSalt(email: string): Promise<{ salt: string }>`
  - `survivorClaim(email: string, survivorAuthVerifier: string): Promise<SurvivorClaim>` where `SurvivorClaim = { escrow: { ciphertext: string; iv: string }; records: SurvivorRecords }`.
  - Exported types `SurvivorBlob`, `SurvivorRecords`, `SurvivorClaim`.

- [ ] **Step 1: Add types + methods to `src/lib/api-client.ts`**

Add near the top (after the existing import):

```ts
export type SurvivorBlob = { id: string; ciphertext: string; iv: string };
export type SurvivorRecords = {
  items: SurvivorBlob[];
  accounts: SurvivorBlob[];
  bills: SurvivorBlob[];
  loans: SurvivorBlob[];
  beneficiaries: SurvivorBlob[];
  obituary: { intake: ObituaryIntake; draft: string } | null;
};
export type SurvivorClaim = {
  escrow: { ciphertext: string; iv: string };
  records: SurvivorRecords;
};
```

Add these properties inside the `api` object (e.g. after `putReadinessState`):

```ts
  survivorStatus: async () => {
    const res = await fetch("/api/survivor");
    if (res.status === 401) return { armed: false, updatedAt: null };
    if (!res.ok) throw new Error("We couldn't check survivor access.");
    return res.json() as Promise<{ armed: boolean; updatedAt: string | null }>;
  },
  armSurvivor: (payload: {
    survivorSalt: string;
    survivorAuthVerifier: string;
    escrowCiphertext: string;
    escrowIv: string;
  }) => post<{ ok: true }>("/api/survivor", payload),
  revokeSurvivor: async () => {
    const res = await fetch("/api/survivor", { method: "DELETE" });
    if (!res.ok) throw new Error("We couldn't remove survivor access.");
    return res.json() as Promise<{ ok: true }>;
  },
  survivorSalt: (email: string) =>
    post<{ salt: string }>("/api/survivor/salt", { email }),
  survivorClaim: (email: string, survivorAuthVerifier: string) =>
    post<SurvivorClaim>("/api/survivor/claim", { email, survivorAuthVerifier }),
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api-client.ts
git commit -m "feat(survivor): api-client methods for arm/status/revoke/salt/claim"
```

---

### Task 9: Owner page (`/survivor`) + nav link

**Files:**
- Create: `src/app/survivor/page.tsx`
- Modify: `src/components/AppNav.tsx` (add link)

**Interfaces:**
- Consumes: `useKey` from `@/app/providers/KeyProvider`; `buildSurvivorEscrow` from `@/lib/survivor-crypto`; `api.survivorStatus/armSurvivor/revokeSurvivor`; `AppNav`, `LegacyMark`.

- [ ] **Step 1: Add the nav link**

In `src/components/AppNav.tsx`, add inside `<div className="navlinks">` after the Beneficiaries link:

```tsx
        <Link href="/survivor">Survivor access</Link>
```

- [ ] **Step 2: Create `src/app/survivor/page.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { useKey } from "@/app/providers/KeyProvider";
import { api } from "@/lib/api-client";
import { buildSurvivorEscrow } from "@/lib/survivor-crypto";

type Status = { armed: boolean; updatedAt: string | null } | null;

export default function SurvivorPage() {
  const { masterKey } = useKey();
  const [status, setStatus] = useState<Status>(null);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.survivorStatus().then(setStatus).catch(() => setError("Couldn't load status."));
  }, []);

  if (!masterKey) return null;

  async function arm() {
    setBusy(true);
    setError("");
    try {
      const result = await buildSurvivorEscrow(masterKey!);
      await api.armSurvivor({
        survivorSalt: result.survivorSalt,
        survivorAuthVerifier: result.survivorAuthVerifier,
        escrowCiphertext: result.escrowCiphertext,
        escrowIv: result.escrowIv,
      });
      setCode(result.recoveryCode);
      setStatus({ armed: true, updatedAt: new Date().toISOString() });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    setError("");
    try {
      await api.revokeSurvivor();
      setStatus({ armed: false, updatedAt: null });
      setCode(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Survivor access</h1>
        <p className="subtle">
          Generate a one-time recovery code and store it somewhere safe — with your lawyer,
          in a sealed letter, or a safe. Anyone who has it can unlock a read-only copy of your
          vault. We can never show the code again, and we never see it.
        </p>

        {code && (
          <div className="item" style={{ textAlign: "center" }}>
            <strong>Your recovery code</strong>
            <div className="notes" style={{ fontSize: "1.25rem", letterSpacing: "0.1em" }}>
              {code}
            </div>
            <p className="error">
              Save this now. It will not be shown again, and it cannot be recovered.
            </p>
            <button type="button" onClick={() => navigator.clipboard?.writeText(code)}>
              Copy code
            </button>
            <button type="button" onClick={() => window.print()}>
              Print
            </button>
          </div>
        )}

        {status?.armed ? (
          <>
            <p className="subtle">
              Survivor access is armed
              {status.updatedAt ? ` (since ${new Date(status.updatedAt).toLocaleDateString()})` : ""}.
            </p>
            <button type="button" onClick={arm} disabled={busy}>
              {busy ? "Working…" : "Regenerate code"}
            </button>
            <p className="subtle">Regenerating immediately invalidates the previous code.</p>
            <button type="button" className="linkbtn" onClick={revoke} disabled={busy}>
              Remove survivor access
            </button>
          </>
        ) : (
          <button type="button" onClick={arm} disabled={busy}>
            {busy ? "Working…" : "Set up survivor access"}
          </button>
        )}

        {error && <p className="error">{error}</p>}
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add src/app/survivor/page.tsx src/components/AppNav.tsx
git commit -m "feat(survivor): owner arm/regenerate/revoke page + nav link"
```

---

### Task 10: Survivor claim page (`/recover`, public)

**Files:**
- Create: `src/app/recover/page.tsx`

**Interfaces:**
- Consumes: `api.survivorSalt/survivorClaim`, `SurvivorRecords` from `@/lib/api-client`; `deriveSurvivorAuthVerifier`, `recoverMasterKey` from `@/lib/survivor-crypto`; `decryptItem` + `CryptoBytes` from `@/lib/crypto`; `parseAccount`, `parseBill`, `parseLoan`, `parseBeneficiary` from their libs; `BrandHeader` from `@/components/Logo`.

> `/recover` is a public route, deliberately outside the owner-authed area and distinct from the owner `/unlock` (vault) and `/survivor` (settings) routes.

- [ ] **Step 1: Create `src/app/recover/page.tsx`**

```tsx
"use client";

import { useState } from "react";
import { BrandHeader } from "@/components/Logo";
import { api, type SurvivorRecords } from "@/lib/api-client";
import { deriveSurvivorAuthVerifier, recoverMasterKey } from "@/lib/survivor-crypto";
import { decryptItem, type CryptoBytes } from "@/lib/crypto";
import { parseAccount, type Account } from "@/lib/account";
import { parseBill, type Bill } from "@/lib/bill";
import { parseLoan, type Loan } from "@/lib/loan";
import { parseBeneficiary, type Beneficiary } from "@/lib/beneficiary";

type Decrypted = {
  accounts: Account[];
  bills: Bill[];
  loans: Loan[];
  beneficiaries: Beneficiary[];
  notes: string[];
  obituary: string | null;
};

async function decryptAll(mk: CryptoBytes, records: SurvivorRecords): Promise<Decrypted> {
  const tryParse = async <T,>(
    rows: { ciphertext: string; iv: string }[],
    parse: (json: string) => T,
  ): Promise<T[]> => {
    const out: T[] = [];
    for (const r of rows) {
      try {
        out.push(parse(await decryptItem(mk, r.ciphertext, r.iv)));
      } catch {
        // skip any record that fails to decrypt
      }
    }
    return out;
  };
  const notes: string[] = [];
  for (const r of records.items) {
    try {
      notes.push(await decryptItem(mk, r.ciphertext, r.iv));
    } catch {
      // skip
    }
  }
  return {
    accounts: await tryParse(records.accounts, parseAccount),
    bills: await tryParse(records.bills, parseBill),
    loans: await tryParse(records.loans, parseLoan),
    beneficiaries: await tryParse(records.beneficiaries, parseBeneficiary),
    notes,
    obituary: records.obituary?.draft ?? null,
  };
}

export default function RecoverPage() {
  const [email, setEmail] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<Decrypted | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { salt } = await api.survivorSalt(email);
      const verifier = await deriveSurvivorAuthVerifier(recoveryCode, salt);
      const claim = await api.survivorClaim(email, verifier).catch(() => {
        throw new Error("That email or recovery code didn't match.");
      });
      const mk = await recoverMasterKey(
        recoveryCode,
        salt,
        claim.escrow.ciphertext,
        claim.escrow.iv,
      );
      setData(await decryptAll(mk, claim.records));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "legacy-records.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (data) {
    return (
      <main className="center">
        <div className="card">
          <BrandHeader />
          <h1>Their Legacy</h1>
          <p className="subtle">Read-only. Nothing here is stored on this device.</p>
          <div className="no-print">
            <button type="button" onClick={() => window.print()}>Print</button>
            <button type="button" onClick={download}>Download</button>
          </div>

          {data.notes.length > 0 && (
            <section>
              <h2>Notes</h2>
              {data.notes.map((n, i) => (
                <div className="item" key={i}><div className="notes">{n}</div></div>
              ))}
            </section>
          )}

          {data.accounts.length > 0 && (
            <section>
              <h2>Accounts</h2>
              {data.accounts.map((a, i) => (
                <div className="item" key={i}>
                  <strong>{a.institution} — {a.nickname}</strong>
                  <div className="meta">{a.type} · {a.accountNumber} · {a.balance}</div>
                  {a.notes && <div className="notes">{a.notes}</div>}
                </div>
              ))}
            </section>
          )}

          {data.bills.length > 0 && (
            <section>
              <h2>Bills</h2>
              {data.bills.map((b, i) => (
                <div className="item" key={i}>
                  <strong>{b.name}</strong>
                  <div className="meta">{b.category} · {b.amount} · {b.frequency} · due {b.nextDueDate}</div>
                  {b.notes && <div className="notes">{b.notes}</div>}
                </div>
              ))}
            </section>
          )}

          {data.loans.length > 0 && (
            <section>
              <h2>Loans</h2>
              {data.loans.map((l, i) => (
                <div className="item" key={i}>
                  <strong>{l.lender} — {l.nickname}</strong>
                  <div className="meta">{l.kind} · balance {l.currentBalance} · {l.interestRate}</div>
                  {l.notes && <div className="notes">{l.notes}</div>}
                </div>
              ))}
            </section>
          )}

          {data.beneficiaries.length > 0 && (
            <section>
              <h2>Beneficiaries</h2>
              {data.beneficiaries.map((b, i) => (
                <div className="item" key={i}>
                  <strong>{b.fullName}</strong>
                  <div className="meta">{b.relationship}{b.allocation ? ` · ${b.allocation}%` : ""}</div>
                  {b.email && <div className="meta">{b.email}</div>}
                  {b.phone && <div className="meta">{b.phone}</div>}
                  {b.mailingAddress && <div className="meta">{b.mailingAddress}</div>}
                  {b.notes && <div className="notes">{b.notes}</div>}
                </div>
              ))}
            </section>
          )}

          {data.obituary && (
            <section>
              <h2>Obituary</h2>
              <div className="item"><div className="notes">{data.obituary}</div></div>
            </section>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="center">
      <form className="card" onSubmit={onSubmit}>
        <BrandHeader />
        <h1>Access a loved one&apos;s Legacy</h1>
        <p className="subtle">
          Enter their email and the recovery code they left you. You&apos;ll see a read-only
          copy of what they saved.
        </p>
        <label htmlFor="email">Their email</label>
        <input id="email" type="email" value={email}
          onChange={(e) => setEmail(e.target.value)} required />
        <label htmlFor="code">Recovery code</label>
        <input id="code" value={recoveryCode}
          onChange={(e) => setRecoveryCode(e.target.value)} required />
        <button type="submit" disabled={busy}>
          {busy ? "Unlocking…" : "Unlock"}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </main>
  );
}
```

- [ ] **Step 2: Add a minimal print style for `.no-print`**

In `src/app/globals.css`, append:

```css
@media print {
  .no-print { display: none; }
}
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed. (If `Account`/`Bill`/`Loan` field names differ from those referenced above, open the lib in `src/lib/<type>.ts` and use the actual field names — the parse types are the source of truth.)

- [ ] **Step 4: Commit**

```bash
git add src/app/recover/page.tsx src/app/globals.css
git commit -m "feat(survivor): public recovery page — claim, decrypt, read-only view, export"
```

---

### Task 11: Live e2e round-trip + no-plaintext proof

**Files:**
- Modify: `e2e.spec.ts` (append a new `it` to the existing `describe`)

**Interfaces:**
- Consumes: the live routes from Tasks 5–7; `buildSurvivorEscrow`, `deriveSurvivorAuthVerifier`, `recoverMasterKey`; `serializeBeneficiary`/`parseBeneficiary`; `decryptItem`.

- [ ] **Step 1: Append the e2e test**

Add inside the `describe("walking skeleton (live)", ...)` block in `e2e.spec.ts`:

```ts
  it("arms survivor access and a survivor recovers the vault (no plaintext stored)", async () => {
    const sEmail = `e2e-survivor-${Date.now()}@example.com`;
    const pass = "survivor-owner-passphrase-123";

    // register + login as owner
    const salt = generateSalt();
    const mk = await deriveMasterKey(pass, salt);
    const av = await deriveAuthVerifier(mk, pass);
    await fetch(`${BASE}/api/auth/register`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: sEmail, salt, authVerifier: av }),
    });
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: sEmail, authVerifier: av }),
    });
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

    // owner stores one encrypted beneficiary
    const bene: Beneficiary = {
      fullName: "Survivor Heir", relationship: "Child", email: "heir@example.com",
      phone: "555-9000", mailingAddress: "1 Elm St", allocation: "100", notes: "Everything",
    };
    const benBlob = await encryptItem(mk, serializeBeneficiary(bene));
    await fetch(`${BASE}/api/beneficiaries`, {
      method: "POST", headers: { ...json, cookie }, body: JSON.stringify(benBlob),
    });

    // --- ARM: wrap the master key client-side, send only salt/verifier/escrow ---
    const arm = await buildSurvivorEscrow(mk);
    const armRes = await fetch(`${BASE}/api/survivor`, {
      method: "POST", headers: { ...json, cookie },
      body: JSON.stringify({
        survivorSalt: arm.survivorSalt,
        survivorAuthVerifier: arm.survivorAuthVerifier,
        escrowCiphertext: arm.escrowCiphertext,
        escrowIv: arm.escrowIv,
      }),
    });
    expect(armRes.status).toBe(201);

    // arming requires auth
    const noAuthArm = await fetch(`${BASE}/api/survivor`, {
      method: "POST", headers: json, body: JSON.stringify({}),
    });
    expect(noAuthArm.status).toBe(401);

    // --- SURVIVOR (no session): fetch salt, derive verifier, claim ---
    const saltRes = await fetch(`${BASE}/api/survivor/salt`, {
      method: "POST", headers: json, body: JSON.stringify({ email: sEmail }),
    });
    const { salt: survivorSalt } = await saltRes.json();
    expect(survivorSalt).toBe(arm.survivorSalt);

    const verifier = await deriveSurvivorAuthVerifier(arm.recoveryCode, survivorSalt);
    const claimRes = await fetch(`${BASE}/api/survivor/claim`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: sEmail, survivorAuthVerifier: verifier }),
    });
    expect(claimRes.status).toBe(200);
    const claim = await claimRes.json();

    // a wrong code is rejected with 401
    const badVerifier = await deriveSurvivorAuthVerifier("00000-00000-00000-00000", survivorSalt);
    const badClaim = await fetch(`${BASE}/api/survivor/claim`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: sEmail, survivorAuthVerifier: badVerifier }),
    });
    expect(badClaim.status).toBe(401);

    // --- RECOVER the master key and decrypt the beneficiary ---
    const recovered = await recoverMasterKey(
      arm.recoveryCode, survivorSalt, claim.escrow.ciphertext, claim.escrow.iv,
    );
    const back = parseBeneficiary(
      await decryptItem(recovered, claim.records.beneficiaries[0].ciphertext,
        claim.records.beneficiaries[0].iv),
    );
    expect(back).toEqual(bene);

    // --- ZERO-KNOWLEDGE: stored survivor row holds only opaque blobs + bcrypt hash ---
    const user = await db.user.findUnique({
      where: { email: sEmail },
      include: { survivorAccess: true },
    });
    const sa = user!.survivorAccess!;
    expect(sa.survivorAuthVerifierHash.startsWith("$2")).toBe(true);
    expect(sa.survivorAuthVerifierHash).not.toBe(arm.survivorAuthVerifier);
    expect(sa.escrowCiphertext).not.toContain("Survivor Heir");
    expect(sa.escrowCiphertext).not.toContain(arm.recoveryCode);

    // cleanup
    await db.user.delete({ where: { email: sEmail } });
  }, 60_000);
```

- [ ] **Step 2: Run the live e2e (requires `npm run dev` running against the dev DB)**

In one terminal: `npm run dev`. In another:

```bash
npx vitest run --config vitest.e2e.config.ts
```

Expected: all e2e tests PASS, including the new survivor test.

- [ ] **Step 3: Commit**

```bash
git add e2e.spec.ts
git commit -m "test(survivor): live e2e round-trip + no-plaintext proof"
```

---

### Task 12: Full verification, manual smoke checklist, tracker update

**Files:**
- Create: `docs/superpowers/manual-verification-survivor.md`
- Modify: `docs/superpowers/manual-verification-pending.md` (link the new checklist)

- [ ] **Step 1: Run the full gate**

Run:

```bash
npm test && npx tsc --noEmit && npm run build
```

Expected: unit tests pass, `tsc` exits 0, build succeeds. Fix anything red before continuing.

- [ ] **Step 2: Write the manual smoke checklist**

Create `docs/superpowers/manual-verification-survivor.md`:

```markdown
# Manual verification — Survivor mode (Sprint 4 Slice 1)

Prereq: `SURVIVOR_SALT_SECRET` is set in `.env` (and `.env.test`). Migration applied to both DBs.

1. Sign in, unlock the vault, add at least one record of each type + an obituary.
2. Go to **Survivor access** → "Set up survivor access". Confirm the recovery code shows once; copy it.
3. Reload `/survivor`. Confirm it shows "armed" and does NOT reveal the code again.
4. Open `/recover` in a private window (no session). Enter the owner email + code → "Unlock".
   - Confirm all records + obituary render read-only.
   - Confirm "Download" produces a JSON file and "Print" hides the buttons.
5. Wrong code on `/recover` → "didn't match" error, no data shown.
6. Unknown email on `/recover` → also fails generically (no enumeration).
7. Back on `/survivor`, "Regenerate code" → old code now fails at `/recover`; new code works.
8. "Remove survivor access" → `/recover` with the code now fails.
```

- [ ] **Step 3: Link it from the pending index**

Add a line under the appropriate section of `docs/superpowers/manual-verification-pending.md`:

```markdown
- Survivor mode (Sprint 4 Slice 1): see `manual-verification-survivor.md`. Note: requires `SURVIVOR_SALT_SECRET` env var in `.env`/`.env.test`.
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/manual-verification-survivor.md docs/superpowers/manual-verification-pending.md
git commit -m "docs(survivor): manual smoke checklist + pending index"
```

---

## Self-Review

**Spec coverage:**
- Escrow-the-master-key crypto → Tasks 2, 4. ✓
- Arm/status/revoke → Task 5. ✓
- Salt + decoy anti-enumeration (`SURVIVOR_SALT_SECRET`) → Task 6. ✓
- Claim releases escrow + all records, generic 401 → Task 7. ✓
- Data model + migration (dev + test) → Task 1. ✓
- Owner page (arm/regenerate/revoke, show code once) + nav → Task 9. ✓
- Public survivor page, read-only all types + obituary, print/download → Task 10. ✓
- Unit + route + live e2e (incl. no-plaintext, obituary exempt) → Tasks 3,4,5,6,7,11. ✓
- ZK invariant asserted in e2e → Task 11. ✓
- Out-of-scope items (dead-man's switch, passphrase-change, per-record flags, rate-limiting) → intentionally absent. ✓

**Placeholder scan:** No TBD/TODO; every code step is complete. ✓

**Type consistency:** `ArmResult`/`buildSurvivorEscrow`/`deriveSurvivorAuthVerifier`/`recoverMasterKey` (Task 4) are consumed with matching signatures in Tasks 9–11. `SurvivorRecords`/`SurvivorClaim` (Task 8) match the claim route's response shape (Task 7) and the survivor page consumer (Task 10). The `items` key (vault) is consistent across route, api-client, and page. ✓
