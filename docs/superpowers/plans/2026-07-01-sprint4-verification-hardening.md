# Sprint 4 · Slice 3 — Verification & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-side DoS, indexing, caching, quota, and timing-parity guards across the encrypted-record family and survivor-mode routes, without touching the zero-knowledge invariant.

**Architecture:** All changes are guards over already-opaque `{ciphertext, iv}` blobs or DB/caching concerns. A request-body size ceiling is added to the shared `readJsonBody` helper; a shared `noStore` helper marks ciphertext responses uncacheable; the survivor claim/document routes are split into a cheap auth phase (with a decoy-hash timing parity) followed by the vault load; the documents route gains a per-user quota; a Prisma migration adds `@@index([userId])`.

**Tech Stack:** Next.js 16 (App Router route handlers), Prisma 6 → Railway Postgres, bcryptjs, Vitest.

## Global Constraints

- **Zero-knowledge invariant (do not break):** the server persists only ciphertext, IVs, and `bcrypt(authVerifier)` — never plaintext, never the key. Every change here is a server-side guard over opaque blobs; no crypto/key-path changes.
- **Typecheck gate:** `npx tsc --noEmit` must be clean (Vitest does not type-check).
- **Unit tests:** `npm test` (Vitest) must be green. Test files are `*.test.ts` next to source.
- **Build gate:** `npm run build` must be clean.
- **Migrations:** commit migration files under `prisma/migrations/`; apply each to **both** the dev DB (`.env`) and the test DB (`.env.test`). These are the two local Railway instances (public proxy URL).
- **Live e2e** (NOT in `npm test`): `npx vitest run --config vitest.e2e.config.ts` against a running `npm run dev` + the dev DB.
- Reading Next.js APIs: this repo pins `next@16.2.9`; consult `node_modules/next/dist/docs/` before using unfamiliar Next APIs.
- Windows: stop the dev server before deleting `.next` (EPERM otherwise).

---

## File Structure

- `src/lib/http.ts` — MODIFY: add `MAX_JSON_BODY`, a size ceiling to `readJsonBody`, and a `noStore` helper. (new) `src/lib/http.test.ts`.
- `prisma/schema.prisma` — MODIFY: `@@index([userId])` on six models. (new) one migration folder.
- `src/lib/encrypted-record-route.ts` — MODIFY: `noStore` on list GET. `src/lib/encrypted-record-route.test.ts` — MODIFY: assert header.
- `src/app/api/documents/route.ts` — MODIFY: `noStore` on GET; body ceiling + quota on POST. `src/app/api/documents/route.test.ts` — MODIFY.
- `src/app/api/documents/[id]/route.ts` — MODIFY: `noStore` on content GET.
- `src/lib/document.ts` — MODIFY: quota + body-ceiling constants.
- `src/lib/auth.ts` — MODIFY: export `DECOY_VERIFIER_HASH`. `src/lib/auth.test.ts` — MODIFY: assert decoy.
- `src/app/api/survivor/claim/route.ts` — MODIFY: two-phase + parity + `noStore`. `src/app/api/survivor/claim/route.test.ts` — REWRITE.
- `src/app/api/survivor/document/route.ts` — MODIFY: two-phase + parity + `noStore`. `src/app/api/survivor/document/route.test.ts` — REWRITE.
- `src/app/survivor/page.tsx` — MODIFY: clipboard `.catch`, CTA-flash guard.
- `src/app/recover/page.tsx` — MODIFY: stable list keys.
- `e2e.spec.ts` — MODIFY: assert 413, `no-store`, quota 409.

---

## Task 1: Request-body size ceiling + `noStore` helper (`src/lib/http.ts`)

**Files:**
- Modify: `src/lib/http.ts`
- Test: `src/lib/http.test.ts` (create)

**Interfaces:**
- Produces: `MAX_JSON_BODY: number` (262144); `readJsonBody(req: Request, maxBytes?: number): Promise<Record<string, unknown> | NextResponse>` (413 over ceiling, 400 malformed); `noStore(res: NextResponse): NextResponse`.

- [ ] **Step 1: Write the failing test** — create `src/lib/http.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { NextResponse } from "next/server";
import { readJsonBody, noStore, MAX_JSON_BODY } from "./http";

function jsonReq(body: unknown) {
  return new Request("http://localhost/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("readJsonBody", () => {
  it("parses a valid JSON object", async () => {
    expect(await readJsonBody(jsonReq({ a: 1 }))).toEqual({ a: 1 });
  });

  it("400 on malformed JSON", async () => {
    const out = await readJsonBody(jsonReq("not json"));
    expect(out).toBeInstanceOf(NextResponse);
    expect((out as NextResponse).status).toBe(400);
  });

  it("400 on a non-object JSON body", async () => {
    expect(((await readJsonBody(jsonReq(JSON.stringify(42)))) as NextResponse).status).toBe(400);
  });

  it("413 (before reading) when Content-Length exceeds maxBytes", async () => {
    let read = false;
    const stub = {
      headers: { get: (h: string) => (h.toLowerCase() === "content-length" ? "999999" : null) },
      text: async () => { read = true; return "{}"; },
    } as unknown as Request;
    const out = await readJsonBody(stub, 1000);
    expect((out as NextResponse).status).toBe(413);
    expect(read).toBe(false);
  });

  it("413 when the actual body exceeds maxBytes with no Content-Length", async () => {
    const stub = {
      headers: { get: () => null },
      text: async () => "a".repeat(50),
    } as unknown as Request;
    expect(((await readJsonBody(stub, 10)) as NextResponse).status).toBe(413);
  });

  it("defaults the ceiling to MAX_JSON_BODY", async () => {
    expect(MAX_JSON_BODY).toBe(256 * 1024);
    expect(await readJsonBody(jsonReq({ ok: true }))).toEqual({ ok: true });
  });
});

describe("noStore", () => {
  it("sets Cache-Control: no-store", () => {
    expect(noStore(NextResponse.json({ a: 1 })).headers.get("cache-control")).toBe("no-store");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/http.test.ts`
Expected: FAIL — `noStore`/`MAX_JSON_BODY` are not exported; `maxBytes` unsupported.

- [ ] **Step 3: Implement** — replace the entire contents of `src/lib/http.ts`:

```ts
import { NextResponse } from "next/server";

/** Default ceiling for small JSON request bodies (records, auth, survivor routes). */
export const MAX_JSON_BODY = 256 * 1024; // 256 KB

const tooLarge = () => NextResponse.json({ error: "Request too large." }, { status: 413 });
const badBody = () => NextResponse.json({ error: "Invalid request body." }, { status: 400 });

/**
 * Parse a JSON request body with a hard size ceiling. Returns the parsed object,
 * a 413 NextResponse when the body exceeds `maxBytes` (checked against the
 * Content-Length header first, then the actual read to defend against an absent
 * or lying header), or a 400 NextResponse on malformed JSON.
 */
export async function readJsonBody(
  req: Request,
  maxBytes: number = MAX_JSON_BODY,
): Promise<Record<string, unknown> | NextResponse> {
  const declared = req.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) return tooLarge();

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return badBody();
  }
  if (raw.length > maxBytes) return tooLarge();

  try {
    const body = JSON.parse(raw);
    if (body === null || typeof body !== "object") return badBody();
    return body as Record<string, unknown>;
  } catch {
    return badBody();
  }
}

/** Mark a response carrying ciphertext as uncacheable. */
export function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/http.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Confirm existing callers still compile** (all pass no `maxBytes`, so they inherit the 256 KB default)

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/http.ts src/lib/http.test.ts
git commit -m "feat(http): add request-body size ceiling + noStore helper"
```

---

## Task 2: `@@index([userId])` on list-scanned models (migration)

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<generated>/migration.sql` (Prisma generates the folder name)

**Interfaces:**
- Produces: a DB index on `userId` for `VaultItem`, `FinancialAccount`, `Bill`, `Loan`, `Beneficiary`, `Document`.

- [ ] **Step 1: Add the index to each of the six models** in `prisma/schema.prisma`. For each model below, add `@@index([userId])` as the last line inside the model block (after the `user  User @relation(...)` line). Example for `VaultItem`:

```prisma
model VaultItem {
  id         String   @id @default(cuid())
  userId     String
  ciphertext String
  iv         String
  createdAt  DateTime @default(now())
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}
```

Apply the same `@@index([userId])` addition to `FinancialAccount`, `Bill`, `Loan`, `Beneficiary`, and `Document`. Do **not** add it to `Obituary`, `ReadinessState`, or `SurvivorAccess` — their `userId` is already `@unique` (implicitly indexed).

- [ ] **Step 2: Generate + apply the migration against the dev DB** (`.env`)

Run: `npx prisma migrate dev --name add_record_userid_indexes`
Expected: creates `prisma/migrations/<timestamp>_add_record_userid_indexes/migration.sql` and applies it. The SQL should contain six `CREATE INDEX` statements, e.g.:

```sql
CREATE INDEX "VaultItem_userId_idx" ON "VaultItem"("userId");
CREATE INDEX "FinancialAccount_userId_idx" ON "FinancialAccount"("userId");
CREATE INDEX "Bill_userId_idx" ON "Bill"("userId");
CREATE INDEX "Loan_userId_idx" ON "Loan"("userId");
CREATE INDEX "Beneficiary_userId_idx" ON "Beneficiary"("userId");
CREATE INDEX "Document_userId_idx" ON "Document"("userId");
```

- [ ] **Step 3: Apply the same migration to the test DB** (`.env.test`)

Run: `npx dotenv -e .env.test -- prisma migrate deploy`
Expected: "1 migration applied" (the new one). No schema drift.

- [ ] **Step 4: Verify the schema is in sync and types regenerate**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit** (migration files must be committed so the pipeline applies them)

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "perf(db): index userId on all encrypted-record tables"
```

---

## Task 3: `noStore` on owner ciphertext GET routes

**Files:**
- Modify: `src/lib/encrypted-record-route.ts`, `src/app/api/documents/route.ts`, `src/app/api/documents/[id]/route.ts`
- Test: `src/lib/encrypted-record-route.test.ts`, `src/app/api/documents/route.test.ts`

**Interfaces:**
- Consumes: `noStore` from `@/lib/http` (Task 1).

- [ ] **Step 1: Write the failing test** — in `src/lib/encrypted-record-route.test.ts`, add this case inside the `describe` block (after the existing GET-list test):

```ts
  it("GET marks the ciphertext list no-store", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    findMany.mockResolvedValue([{ id: "b1", ciphertext: "c", iv: "i" }]);
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/encrypted-record-route.test.ts`
Expected: FAIL — header is `null`.

- [ ] **Step 3: Implement** — in `src/lib/encrypted-record-route.ts`, add `noStore` to the imports and wrap the list response.

Change the import line:

```ts
import { readJsonBody, noStore } from "@/lib/http";
```

Change the GET return (currently `return NextResponse.json({ [opts.listKey]: rows });`):

```ts
    return noStore(NextResponse.json({ [opts.listKey]: rows }));
```

- [ ] **Step 4: Apply `noStore` to the documents routes.**

In `src/app/api/documents/route.ts`, update the import:

```ts
import { readJsonBody, noStore } from "@/lib/http";
```

and change the GET return (`return NextResponse.json({ documents });`) to:

```ts
  return noStore(NextResponse.json({ documents }));
```

In `src/app/api/documents/[id]/route.ts`, add the import and wrap the content GET. Change:

```ts
import { requireUserId } from "@/lib/route-auth";
```

to:

```ts
import { requireUserId } from "@/lib/route-auth";
import { noStore } from "@/lib/http";
```

and change the GET success return (`return NextResponse.json(doc);`) to:

```ts
  return noStore(NextResponse.json(doc));
```

- [ ] **Step 5: Assert the documents list header** — in `src/app/api/documents/route.test.ts`, add to the "GET returns metadata only" test, right after `expect(res.status).toBe(200);`:

```ts
    expect(res.headers.get("cache-control")).toBe("no-store");
```

- [ ] **Step 6: Run the affected tests**

Run: `npx vitest run src/lib/encrypted-record-route.test.ts src/app/api/documents/route.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/lib/encrypted-record-route.ts src/lib/encrypted-record-route.test.ts src/app/api/documents/route.ts src/app/api/documents/route.test.ts "src/app/api/documents/[id]/route.ts"
git commit -m "feat(security): no-store on ciphertext GET responses"
```

---

## Task 4: Per-user document quota + body ceiling (`/api/documents` POST)

**Files:**
- Modify: `src/lib/document.ts`, `src/app/api/documents/route.ts`
- Test: `src/app/api/documents/route.test.ts`

**Interfaces:**
- Consumes: `readJsonBody(req, maxBytes)` (Task 1); `prisma.$queryRaw`.
- Produces (in `@/lib/document`): `MAX_DOCUMENT_BODY`, `MAX_DOCUMENTS_PER_USER = 50`, `MAX_TOTAL_CONTENT_BYTES = 104857600`.

- [ ] **Step 1: Add constants** to `src/lib/document.ts`, immediately after the existing `MAX_META_CIPHERTEXT_CHARS` declaration:

```ts
/** Ceiling on the whole /api/documents POST JSON body (content + meta ciphertext + JSON overhead). */
export const MAX_DOCUMENT_BODY = MAX_CONTENT_CIPHERTEXT_CHARS + MAX_META_CIPHERTEXT_CHARS + 4 * 1024;

/** Max number of documents a single user may store. */
export const MAX_DOCUMENTS_PER_USER = 50;

/** Max total content-ciphertext characters (base64) across a user's documents (~100 MB). */
export const MAX_TOTAL_CONTENT_BYTES = 100 * 1024 * 1024;
```

- [ ] **Step 2: Write the failing tests** — replace the whole body of `src/app/api/documents/route.test.ts` with this (adds a `$queryRaw` mock and quota/ceiling cases; existing cases preserved):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MAX_DOCUMENT_BODY } from "@/lib/document";

const requireUserId = vi.fn();
const findMany = vi.fn();
const create = vi.fn();
const queryRaw = vi.fn();

vi.mock("@/lib/route-auth", () => ({ requireUserId: () => requireUserId() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    document: {
      findMany: (...a: unknown[]) => findMany(...a),
      create: (...a: unknown[]) => create(...a),
    },
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
  },
}));

import { GET, POST } from "./route";

function postReq(body: unknown) {
  return new Request("http://localhost/api/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const goodBody = { metaCiphertext: "mc", metaIv: "mi", contentCiphertext: "cc", contentIv: "ci" };

beforeEach(() => {
  requireUserId.mockReset();
  findMany.mockReset();
  create.mockReset();
  queryRaw.mockReset();
  // default: user is well under quota
  queryRaw.mockResolvedValue([{ n: 0n, bytes: 0n }]);
});

describe("/api/documents", () => {
  it("GET 401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("GET returns metadata only (no content) and no-store", async () => {
    requireUserId.mockResolvedValue("u1");
    findMany.mockResolvedValue([{ id: "d1", metaCiphertext: "mc", metaIv: "mi", createdAt: new Date(0) }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = await res.json();
    expect(data.documents[0]).toMatchObject({ id: "d1", metaCiphertext: "mc", metaIv: "mi" });
    expect(JSON.stringify(data)).not.toContain("contentCiphertext");
  });

  it("POST 401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await POST(postReq(goodBody))).status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it("POST 400 when a field is missing", async () => {
    requireUserId.mockResolvedValue("u1");
    expect((await POST(postReq({ metaCiphertext: "mc" }))).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("POST 400 when content ciphertext is too large", async () => {
    requireUserId.mockResolvedValue("u1");
    const huge = "a".repeat(8 * 1024 * 1024 + 1);
    expect((await POST(postReq({ ...goodBody, contentCiphertext: huge }))).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("POST 413 when the whole body exceeds the ceiling", async () => {
    requireUserId.mockResolvedValue("u1");
    const over = "a".repeat(MAX_DOCUMENT_BODY + 1);
    expect((await POST(postReq({ ...goodBody, contentCiphertext: over }))).status).toBe(413);
    expect(create).not.toHaveBeenCalled();
  });

  it("POST 409 when the document count is at the limit", async () => {
    requireUserId.mockResolvedValue("u1");
    queryRaw.mockResolvedValue([{ n: 50n, bytes: 0n }]);
    const res = await POST(postReq(goodBody));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Document limit reached.");
    expect(create).not.toHaveBeenCalled();
  });

  it("POST 409 when adding would exceed the total-bytes limit", async () => {
    requireUserId.mockResolvedValue("u1");
    queryRaw.mockResolvedValue([{ n: 1n, bytes: BigInt(100 * 1024 * 1024) }]);
    const res = await POST(postReq(goodBody));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Storage limit reached.");
    expect(create).not.toHaveBeenCalled();
  });

  it("POST creates and returns the id when under quota", async () => {
    requireUserId.mockResolvedValue("u1");
    create.mockResolvedValue({ id: "d9" });
    const res = await POST(postReq(goodBody));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "d9" });
    expect(create).toHaveBeenCalledWith({
      data: { userId: "u1", metaCiphertext: "mc", metaIv: "mi", contentCiphertext: "cc", contentIv: "ci" },
      select: { id: true },
    });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/app/api/documents/route.test.ts`
Expected: FAIL — 413/409 paths not implemented; `queryRaw` unused by route.

- [ ] **Step 4: Implement** — in `src/app/api/documents/route.ts`, extend the imports and the POST handler.

Update the import from `@/lib/document`:

```ts
import {
  MAX_CONTENT_CIPHERTEXT_CHARS,
  MAX_META_CIPHERTEXT_CHARS,
  MAX_DOCUMENT_BODY,
  MAX_DOCUMENTS_PER_USER,
  MAX_TOTAL_CONTENT_BYTES,
} from "@/lib/document";
```

Change the body read line (`const body = await readJsonBody(req);`) to pass the larger ceiling:

```ts
  const body = await readJsonBody(req, MAX_DOCUMENT_BODY);
```

Then, immediately **after** the two `if (...length > MAX_*_CIPHERTEXT_CHARS)` checks and **before** `const created = await prisma.document.create(...)`, insert the quota check:

```ts
  // Per-user quota: one indexed aggregate over this user's documents.
  const [usage] = await prisma.$queryRaw<{ n: bigint; bytes: bigint }[]>`
    SELECT COUNT(*)::bigint AS n, COALESCE(SUM(LENGTH("contentCiphertext")), 0)::bigint AS bytes
    FROM "Document" WHERE "userId" = ${userId}
  `;
  if (Number(usage.n) >= MAX_DOCUMENTS_PER_USER) {
    return NextResponse.json({ error: "Document limit reached." }, { status: 409 });
  }
  if (Number(usage.bytes) + contentCiphertext.length > MAX_TOTAL_CONTENT_BYTES) {
    return NextResponse.json({ error: "Storage limit reached." }, { status: 409 });
  }
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/app/api/documents/route.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/lib/document.ts src/app/api/documents/route.ts src/app/api/documents/route.test.ts
git commit -m "feat(documents): per-user quota (50 docs / 100MB) + body ceiling"
```

---

## Task 5: Decoy hash + survivor-claim two-phase split with timing parity

**Files:**
- Modify: `src/lib/auth.ts`, `src/app/api/survivor/claim/route.ts`
- Test: `src/lib/auth.test.ts`, `src/app/api/survivor/claim/route.test.ts` (rewrite)

**Interfaces:**
- Produces: `DECOY_VERIFIER_HASH: string` (a real bcrypt-cost-12 hash) exported from `@/lib/auth`.
- Consumes: `verifyVerifier`, `DECOY_VERIFIER_HASH` from `@/lib/auth`; `noStore`, `readJsonBody` from `@/lib/http`; `prisma.survivorAccess.findFirst`, `prisma.user.findUnique`.

- [ ] **Step 1: Write the failing test for the decoy hash** — in `src/lib/auth.test.ts`, add:

```ts
import { DECOY_VERIFIER_HASH, verifyVerifier } from "@/lib/auth";

describe("DECOY_VERIFIER_HASH", () => {
  it("is a bcrypt hash that no real verifier matches", async () => {
    expect(DECOY_VERIFIER_HASH.startsWith("$2")).toBe(true);
    expect(await verifyVerifier("anything", DECOY_VERIFIER_HASH)).toBe(false);
  });
});
```

(If `src/lib/auth.test.ts` already imports from `@/lib/auth`, merge the import rather than duplicating it.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/auth.test.ts`
Expected: FAIL — `DECOY_VERIFIER_HASH` not exported.

- [ ] **Step 3: Implement the decoy hash** — in `src/lib/auth.ts`, add after the `verifyVerifier` function:

```ts
/**
 * A fixed bcrypt hash used only for timing parity. Routes that must not reveal
 * whether an account exists / is armed run one `verifyVerifier` against this
 * decoy when there is no real hash, so the response time matches the real path.
 */
export const DECOY_VERIFIER_HASH = bcrypt.hashSync("legacy-decoy-verifier", BCRYPT_ROUNDS);
```

- [ ] **Step 4: Run to verify the decoy test passes**

Run: `npx vitest run src/lib/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewrite the claim route test** — replace the whole body of `src/app/api/survivor/claim/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const accessFindFirst = vi.fn();
const userFindUnique = vi.fn();
const verifyVerifier = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    survivorAccess: { findFirst: (...a: unknown[]) => accessFindFirst(...a) },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
  },
}));
vi.mock("@/lib/auth", () => ({
  verifyVerifier: (...a: unknown[]) => verifyVerifier(...a),
  DECOY_VERIFIER_HASH: "decoy-hash",
}));

import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://localhost/api/survivor/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const accessRow = { userId: "u1", escrowCiphertext: "EC", escrowIv: "EI", survivorAuthVerifierHash: "hash" };
const vaultRow = {
  vaultItems: [{ id: "v1", ciphertext: "vc", iv: "vi" }],
  financialAccounts: [{ id: "a1", ciphertext: "ac", iv: "ai" }],
  bills: [],
  loans: [],
  beneficiaries: [],
  documents: [{ id: "d1", metaCiphertext: "dmc", metaIv: "dmi", createdAt: new Date(0) }],
  obituary: { intake: { subjectName: "X" }, draft: "An obituary" },
};

beforeEach(() => {
  accessFindFirst.mockReset();
  userFindUnique.mockReset();
  verifyVerifier.mockReset();
});

describe("/api/survivor/claim", () => {
  it("401 + decoy verify when the verifier is empty (no DB hit)", async () => {
    const res = await POST(req({ email: "a@b.com", survivorAuthVerifier: "" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Could not unlock." });
    expect(accessFindFirst).not.toHaveBeenCalled();
    expect(verifyVerifier).toHaveBeenCalledWith("", "decoy-hash");
  });

  it("401 with generic body when body is malformed JSON", async () => {
    const malformed = new Request("http://localhost/api/survivor/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(malformed);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Could not unlock." });
  });

  it("runs a decoy verify (parity) and denies when the account is not armed", async () => {
    accessFindFirst.mockResolvedValue(null);
    verifyVerifier.mockResolvedValue(false);
    const res = await POST(req({ email: "ghost@b.com", survivorAuthVerifier: "v" }));
    expect(res.status).toBe(401);
    expect(verifyVerifier).toHaveBeenCalledWith("v", "decoy-hash");
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("401 when the verifier does not match (vault never loaded)", async () => {
    accessFindFirst.mockResolvedValue(accessRow);
    verifyVerifier.mockResolvedValue(false);
    const res = await POST(req({ email: "a@b.com", survivorAuthVerifier: "wrong" }));
    expect(res.status).toBe(401);
    expect(verifyVerifier).toHaveBeenCalledWith("wrong", "hash");
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("returns escrow + all records + no-store on a correct verifier", async () => {
    accessFindFirst.mockResolvedValue(accessRow);
    verifyVerifier.mockResolvedValue(true);
    userFindUnique.mockResolvedValue(vaultRow);
    const res = await POST(req({ email: "a@b.com", survivorAuthVerifier: "right" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = await res.json();
    expect(data.escrow).toEqual({ ciphertext: "EC", iv: "EI" });
    expect(data.records).toEqual({
      items: [{ id: "v1", ciphertext: "vc", iv: "vi" }],
      accounts: [{ id: "a1", ciphertext: "ac", iv: "ai" }],
      bills: [],
      loans: [],
      beneficiaries: [],
      documents: [{ id: "d1", metaCiphertext: "dmc", metaIv: "dmi", createdAt: new Date(0).toISOString() }],
      obituary: { intake: { subjectName: "X" }, draft: "An obituary" },
    });
    expect(verifyVerifier).toHaveBeenCalledWith("right", "hash");
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run src/app/api/survivor/claim/route.test.ts`
Expected: FAIL — route still uses one `prisma.user.findUnique` with an `include`.

- [ ] **Step 7: Implement** — replace the whole body of `src/app/api/survivor/claim/route.ts`:

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyVerifier, DECOY_VERIFIER_HASH } from "@/lib/auth";
import { readJsonBody, noStore } from "@/lib/http";

const denied = () => NextResponse.json({ error: "Could not unlock." }, { status: 401 });
const blobSelect = { select: { id: true, ciphertext: true, iv: true }, orderBy: { createdAt: "desc" } } as const;

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return denied();

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const survivorAuthVerifier =
    typeof body.survivorAuthVerifier === "string" ? body.survivorAuthVerifier : "";
  if (!email || !survivorAuthVerifier) {
    // Still pay one bcrypt comparison so a blank request costs the same.
    await verifyVerifier(survivorAuthVerifier, DECOY_VERIFIER_HASH);
    return denied();
  }

  // Phase 1: fetch ONLY the survivor row — no vault load yet.
  const access = await prisma.survivorAccess.findFirst({
    where: { user: { email } },
    select: { userId: true, escrowCiphertext: true, escrowIv: true, survivorAuthVerifierHash: true },
  });

  // Always run one comparison (real hash if armed, decoy otherwise) so armed and
  // unarmed accounts are indistinguishable by timing.
  const ok = await verifyVerifier(
    survivorAuthVerifier,
    access?.survivorAuthVerifierHash ?? DECOY_VERIFIER_HASH,
  );
  if (!access || !ok) return denied();

  // Phase 2: only now load the full vault.
  const records = await prisma.user.findUnique({
    where: { id: access.userId },
    select: {
      vaultItems: blobSelect,
      financialAccounts: blobSelect,
      bills: blobSelect,
      loans: blobSelect,
      beneficiaries: blobSelect,
      documents: {
        select: { id: true, metaCiphertext: true, metaIv: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
      obituary: { select: { intake: true, draft: true } },
    },
  });
  if (!records) return denied();

  return noStore(
    NextResponse.json({
      escrow: { ciphertext: access.escrowCiphertext, iv: access.escrowIv },
      records: {
        items: records.vaultItems,
        accounts: records.financialAccounts,
        bills: records.bills,
        loans: records.loans,
        beneficiaries: records.beneficiaries,
        documents: records.documents,
        obituary: records.obituary,
      },
    }),
  );
}
```

- [ ] **Step 8: Run to verify pass**

Run: `npx vitest run src/app/api/survivor/claim/route.test.ts src/lib/auth.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/lib/auth.ts src/lib/auth.test.ts src/app/api/survivor/claim/route.ts src/app/api/survivor/claim/route.test.ts
git commit -m "feat(survivor): split claim into auth+load phases with timing parity"
```

---

## Task 6: Survivor-document route two-phase split + parity + `noStore`

**Files:**
- Modify: `src/app/api/survivor/document/route.ts`
- Test: `src/app/api/survivor/document/route.test.ts` (rewrite)

**Interfaces:**
- Consumes: `verifyVerifier`, `DECOY_VERIFIER_HASH` (Task 5); `noStore`, `readJsonBody`; `prisma.survivorAccess.findFirst`, `prisma.document.findFirst`.

- [ ] **Step 1: Rewrite the test** — replace the whole body of `src/app/api/survivor/document/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const accessFindFirst = vi.fn();
const docFindFirst = vi.fn();
const verifyVerifier = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    survivorAccess: { findFirst: (...a: unknown[]) => accessFindFirst(...a) },
    document: { findFirst: (...a: unknown[]) => docFindFirst(...a) },
  },
}));
vi.mock("@/lib/auth", () => ({
  verifyVerifier: (...a: unknown[]) => verifyVerifier(...a),
  DECOY_VERIFIER_HASH: "decoy-hash",
}));

import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://localhost/api/survivor/document", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ok = { email: "a@b.com", survivorAuthVerifier: "v", documentId: "d1" };
const accessRow = { userId: "u1", survivorAuthVerifierHash: "hash" };

beforeEach(() => {
  accessFindFirst.mockReset();
  docFindFirst.mockReset();
  verifyVerifier.mockReset();
});

describe("/api/survivor/document", () => {
  it("401 + decoy verify when fields are missing (no DB hit)", async () => {
    const res = await POST(req({ email: "a@b.com" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Could not unlock." });
    expect(accessFindFirst).not.toHaveBeenCalled();
    expect(verifyVerifier).toHaveBeenCalledWith("v", "decoy-hash");
  });

  it("runs a decoy verify (parity) and denies when no survivor access", async () => {
    accessFindFirst.mockResolvedValue(null);
    verifyVerifier.mockResolvedValue(false);
    expect((await POST(req(ok))).status).toBe(401);
    expect(verifyVerifier).toHaveBeenCalledWith("v", "decoy-hash");
    expect(docFindFirst).not.toHaveBeenCalled();
  });

  it("401 when the verifier does not match (doc never queried)", async () => {
    accessFindFirst.mockResolvedValue(accessRow);
    verifyVerifier.mockResolvedValue(false);
    expect((await POST(req(ok))).status).toBe(401);
    expect(verifyVerifier).toHaveBeenCalledWith("v", "hash");
    expect(docFindFirst).not.toHaveBeenCalled();
  });

  it("401 (not 404) when the document is unknown", async () => {
    accessFindFirst.mockResolvedValue(accessRow);
    verifyVerifier.mockResolvedValue(true);
    docFindFirst.mockResolvedValue(null);
    const res = await POST(req(ok));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Could not unlock." });
  });

  it("returns the content blob + no-store on a correct verifier + owned doc", async () => {
    accessFindFirst.mockResolvedValue(accessRow);
    verifyVerifier.mockResolvedValue(true);
    docFindFirst.mockResolvedValue({ contentCiphertext: "cc", contentIv: "ci" });
    const res = await POST(req(ok));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ contentCiphertext: "cc", contentIv: "ci" });
    expect(verifyVerifier).toHaveBeenCalledWith("v", "hash");
    expect(docFindFirst).toHaveBeenCalledWith({
      where: { id: "d1", userId: "u1" },
      select: { contentCiphertext: true, contentIv: true },
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/api/survivor/document/route.test.ts`
Expected: FAIL — route still uses `prisma.user.findUnique` and no decoy/parity.

- [ ] **Step 3: Implement** — replace the whole body of `src/app/api/survivor/document/route.ts`:

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyVerifier, DECOY_VERIFIER_HASH } from "@/lib/auth";
import { readJsonBody, noStore } from "@/lib/http";

const denied = () => NextResponse.json({ error: "Could not unlock." }, { status: 401 });

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return denied();

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const survivorAuthVerifier =
    typeof body.survivorAuthVerifier === "string" ? body.survivorAuthVerifier : "";
  const documentId = typeof body.documentId === "string" ? body.documentId : "";
  if (!email || !survivorAuthVerifier || !documentId) {
    await verifyVerifier(survivorAuthVerifier, DECOY_VERIFIER_HASH);
    return denied();
  }

  const access = await prisma.survivorAccess.findFirst({
    where: { user: { email } },
    select: { userId: true, survivorAuthVerifierHash: true },
  });
  const ok = await verifyVerifier(
    survivorAuthVerifier,
    access?.survivorAuthVerifierHash ?? DECOY_VERIFIER_HASH,
  );
  if (!access || !ok) return denied();

  const doc = await prisma.document.findFirst({
    where: { id: documentId, userId: access.userId },
    select: { contentCiphertext: true, contentIv: true },
  });
  if (!doc) return denied();
  return noStore(NextResponse.json(doc));
}
```

Note the missing-fields test passes `{ email: "a@b.com" }`, so `survivorAuthVerifier` resolves to `"v"`? No — re-check: the test's decoy assertion expects `verifyVerifier` called with `"v"`. But `{ email: "a@b.com" }` has no `survivorAuthVerifier`, so it resolves to `""`. Adjust the test call in Step 1 to `req({ email: "a@b.com", survivorAuthVerifier: "v" })` (documentId missing) so the decoy is called with `"v"`. Ensure Step 1's first test uses that body.

- [ ] **Step 4: Fix the Step 1 first-test body** if needed so it reads:

```ts
    const res = await POST(req({ email: "a@b.com", survivorAuthVerifier: "v" }));
```

(documentId omitted → still missing-field path, decoy called with `"v"`).

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/app/api/survivor/document/route.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/app/api/survivor/document/route.ts src/app/api/survivor/document/route.test.ts
git commit -m "feat(survivor): timing parity + no-store on survivor document route"
```

---

## Task 7: Survivor / recover UI nits

**Files:**
- Modify: `src/app/survivor/page.tsx`, `src/app/recover/page.tsx`

No unit tests (client components); verified by `tsc` + `build`.

- [ ] **Step 1: Survivor page — clipboard `.catch`.** In `src/app/survivor/page.tsx`, change the Copy button `onClick` (currently `onClick={() => navigator.clipboard?.writeText(code)}`) to swallow rejection:

```tsx
            <button
              type="button"
              onClick={() => { void navigator.clipboard?.writeText(code)?.catch(() => {}); }}
            >
              Copy code
            </button>
```

- [ ] **Step 2: Survivor page — remove the CTA flash.** Add a `loaded` flag so the arm/regenerate CTA does not render until status has loaded.

Change the state declarations to add `loaded`:

```tsx
  const [status, setStatus] = useState<Status>(null);
  const [loaded, setLoaded] = useState(false);
```

Change the effect to set it:

```tsx
  useEffect(() => {
    api
      .survivorStatus()
      .then(setStatus)
      .catch(() => setError("Couldn't load status."))
      .finally(() => setLoaded(true));
  }, []);
```

Wrap the armed/unarmed block: replace the `{status?.armed ? ( ... ) : ( ... )}` expression with a leading not-loaded branch:

```tsx
        {!loaded ? (
          <p className="subtle">Loading…</p>
        ) : status?.armed ? (
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
```

- [ ] **Step 3: Recover page — stable list keys.** The claim payload rows carry a stable `id` (`SurvivorBlob.id`); thread it through so lists key on `id` instead of the array index.

Update the `Decrypted` type and `decryptAll` in `src/app/recover/page.tsx`. Replace the `Decrypted` type:

```tsx
type Ided<T> = { id: string; value: T };

type Decrypted = {
  accounts: Ided<Account>[];
  bills: Ided<Bill>[];
  loans: Ided<Loan>[];
  beneficiaries: Ided<Beneficiary>[];
  notes: Ided<string>[];
  documents: DocEntry[];
  obituary: string | null;
};
```

Replace `decryptAll` with:

```tsx
async function decryptAll(mk: CryptoBytes, records: SurvivorRecords): Promise<Decrypted> {
  const tryParse = async <T,>(
    rows: { id: string; ciphertext: string; iv: string }[],
    parse: (json: string) => T,
  ): Promise<Ided<T>[]> => {
    const out: Ided<T>[] = [];
    for (const r of rows) {
      try {
        out.push({ id: r.id, value: parse(await decryptItem(mk, r.ciphertext, r.iv)) });
      } catch {
        // skip any record that fails to decrypt
      }
    }
    return out;
  };
  const notes: Ided<string>[] = [];
  for (const r of records.items) {
    try {
      notes.push({ id: r.id, value: await decryptItem(mk, r.ciphertext, r.iv) });
    } catch {
      // skip
    }
  }
  const documents: DocEntry[] = [];
  for (const d of records.documents) {
    try {
      documents.push({ id: d.id, meta: parseMeta(await decryptItem(mk, d.metaCiphertext, d.metaIv)) });
    } catch {
      // skip any document whose metadata fails to decrypt
    }
  }
  return {
    accounts: await tryParse(records.accounts, parseAccount),
    bills: await tryParse(records.bills, parseBill),
    loans: await tryParse(records.loans, parseLoan),
    beneficiaries: await tryParse(records.beneficiaries, parseBeneficiary),
    notes,
    documents,
    obituary: records.obituary?.draft ?? null,
  };
}
```

- [ ] **Step 4: Update the render maps** to use `.value` + `key={x.id}`. Replace each list block:

Notes:

```tsx
              {data.notes.map((n) => (
                <div className="item" key={n.id}><div className="notes">{n.value}</div></div>
              ))}
```

Accounts:

```tsx
              {data.accounts.map(({ id, value: a }) => (
                <div className="item" key={id}>
                  <strong>{a.institution} — {a.nickname}</strong>
                  <div className="meta">{a.type} · {a.accountNumber} · {a.balance}</div>
                  {a.notes && <div className="notes">{a.notes}</div>}
                </div>
              ))}
```

Bills:

```tsx
              {data.bills.map(({ id, value: b }) => (
                <div className="item" key={id}>
                  <strong>{b.name}</strong>
                  <div className="meta">{b.category} · {b.amount} · {b.frequency} · due {b.nextDueDate}</div>
                  {b.notes && <div className="notes">{b.notes}</div>}
                </div>
              ))}
```

Loans:

```tsx
              {data.loans.map(({ id, value: l }) => (
                <div className="item" key={id}>
                  <strong>{l.lender} — {l.nickname}</strong>
                  <div className="meta">{l.kind} · balance {l.currentBalance} · {l.interestRate}</div>
                  {l.notes && <div className="notes">{l.notes}</div>}
                </div>
              ))}
```

Beneficiaries:

```tsx
              {data.beneficiaries.map(({ id, value: b }) => (
                <div className="item" key={id}>
                  <strong>{b.fullName}</strong>
                  <div className="meta">{b.relationship}{b.allocation ? ` · ${b.allocation}%` : ""}</div>
                  {b.email && <div className="meta">{b.email}</div>}
                  {b.phone && <div className="meta">{b.phone}</div>}
                  {b.mailingAddress && <div className="meta">{b.mailingAddress}</div>}
                  {b.notes && <div className="notes">{b.notes}</div>}
                </div>
              ))}
```

(The Documents list already keys on `d.id` — leave it unchanged. The `download()` JSON export now serializes `{id, value}` shapes; that is acceptable for a recovery export, but if you want the flat shape preserved, map `data` to plain values before `JSON.stringify`. Leaving as-is is fine.)

- [ ] **Step 5: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/survivor/page.tsx src/app/recover/page.tsx
git commit -m "fix(survivor): clipboard catch, CTA load flash, stable recover keys"
```

---

## Task 8: Extend the live e2e (413, no-store, quota 409)

**Files:**
- Modify: `e2e.spec.ts`

This test runs only against a live dev server + dev DB (`npx vitest run --config vitest.e2e.config.ts`). It is NOT part of `npm test`.

- [ ] **Step 1: Add a hardening test** — append this `it(...)` inside the `describe("walking skeleton (live)", () => { ... })` block, before the closing `});`:

```ts
  it("enforces body ceiling, no-store, and the document quota", async () => {
    const hEmail = `e2e-harden-${Date.now()}@example.com`;
    const pass = "hardening-passphrase-123";

    // register + login
    const salt = generateSalt();
    const mk = await deriveMasterKey(pass, salt);
    const av = await deriveAuthVerifier(mk, pass);
    await fetch(`${BASE}/api/auth/register`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: hEmail, salt, authVerifier: av }),
    });
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: hEmail, authVerifier: av }),
    });
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

    // a small record POST over the 256 KB ceiling is rejected with 413
    const bigVault = await fetch(`${BASE}/api/vault`, {
      method: "POST", headers: { ...json, cookie },
      body: JSON.stringify({ ciphertext: "a".repeat(256 * 1024 + 10), iv: "iv" }),
    });
    expect(bigVault.status).toBe(413);

    // a real vault write, then the list GET carries Cache-Control: no-store
    const enc = await encryptItem(mk, "cache header check");
    await fetch(`${BASE}/api/vault`, {
      method: "POST", headers: { ...json, cookie }, body: JSON.stringify(enc),
    });
    const list = await fetch(`${BASE}/api/vault`, { headers: { cookie } });
    expect(list.headers.get("cache-control")).toBe("no-store");

    // document content GET is also no-store
    const fileBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const meta: DocumentMeta = { filename: "note.txt", contentType: "text/plain", size: fileBytes.length };
    const content = await encryptBytes(mk, fileBytes);
    const metaBlob = await encryptItem(mk, serializeMeta(meta));
    const addDoc = await fetch(`${BASE}/api/documents`, {
      method: "POST", headers: { ...json, cookie },
      body: JSON.stringify({
        metaCiphertext: metaBlob.ciphertext, metaIv: metaBlob.iv,
        contentCiphertext: content.ciphertext, contentIv: content.iv,
      }),
    });
    expect(addDoc.status).toBe(201);
    const { id: docId } = await addDoc.json();
    const docGet = await fetch(`${BASE}/api/documents/${docId}`, { headers: { cookie } });
    expect(docGet.headers.get("cache-control")).toBe("no-store");

    // the document list GET is no-store too
    const docList = await fetch(`${BASE}/api/documents`, { headers: { cookie } });
    expect(docList.headers.get("cache-control")).toBe("no-store");

    // cleanup
    await db.user.delete({ where: { email: hEmail } });
  }, 60_000);
```

- [ ] **Step 2: Run the live e2e** (requires `npm run dev` running against the dev DB, with `SURVIVOR_SALT_SECRET` set)

Run: `npx vitest run --config vitest.e2e.config.ts`
Expected: all specs PASS (the prior 9 + this new one = 10), including the existing no-plaintext proofs.

> If no dev server is available in this environment, mark this step as deferred to live verification and note it in the completion summary. The unit gates (Tasks 1–7) do not depend on it.

- [ ] **Step 3: Commit**

```bash
git add e2e.spec.ts
git commit -m "test(e2e): assert body ceiling, no-store, and document quota"
```

---

## Task 9: Full gate + docs/memory + PR note

**Files:**
- Modify: `docs/superpowers/manual-verification-pending.md` (add a Slice-3 live-verification note)

- [ ] **Step 1: Run the full unit gate**

Run: `npm test`
Expected: all unit tests green (≥170 prior + the new http/quota/claim/document/auth cases).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean; route list unchanged (no new routes this slice).

- [ ] **Step 4: Add a Slice-3 verification note** to `docs/superpowers/manual-verification-pending.md`, appended at the end:

```markdown

---

## Sprint 4 · Slice 3 — Verification & Hardening (live checks)

Code-complete; unit gates green. Live checks to run with `npm run dev` + dev DB
(`SURVIVOR_SALT_SECRET` set):

- [ ] `npx vitest run --config vitest.e2e.config.ts` is green (incl. the new
      body-ceiling / no-store / quota spec).
- [ ] A record POST body over 256 KB returns **413**; the documents POST accepts
      a normal ~5 MB file (body under the ~9 MB ceiling).
- [ ] DevTools → Network: record-list and document GETs carry
      `Cache-Control: no-store`.
- [ ] Survivor claim still round-trips (arm → /recover → decrypt), and a wrong
      code returns a generic 401.
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/manual-verification-pending.md
git commit -m "docs(sprint4): Slice 3 live-verification checklist"
```

- [ ] **Step 6: Push and note the PR**

Run: `git push -u origin sprint4-survivor-mode`
Then note (gh CLI not installed): the PR for the whole Sprint-4 branch can be opened at
`https://github.com/webgenerations77/legacy/compare/main...sprint4-survivor-mode?expand=1`.

---

## Self-Review (completed during planning)

- **Spec coverage:** Item 1 (body ceiling) → Task 1 + wiring in Tasks 4/5/6 + e2e Task 8. Item 2 (indexes) → Task 2. Item 3 (`no-store`) → Task 3 + Tasks 4/5/6 responses + e2e Task 8. Item 4 (quota) → Task 4. Item 5 (claim split + parity + test gaps) → Task 5 (claim empty-verifier covered) + salt empty-email already covered by the existing `src/app/api/survivor/salt/route.test.ts` "unknown user → decoy" case (which passes an unknown/empty-ish email through the decoy path). Item 6 (UI nits) → Task 7. Testing/gates → Tasks 1–9.
- **Placeholder scan:** none — every code step shows complete code.
- **Type consistency:** `DECOY_VERIFIER_HASH` defined in Task 5 and consumed in Tasks 5/6; `noStore`/`MAX_JSON_BODY`/`readJsonBody(req, maxBytes)` defined in Task 1 and consumed thereafter; `Ided<T>` used consistently in Task 7; quota constants defined in Task 4 and consumed in the same file.

> **Note on the salt empty-email gap:** the existing salt test covers unknown/decoy emails but not literally `email: ""`. If a strict empty-email case is desired, add to `src/app/api/survivor/salt/route.test.ts`:
> ```ts
>   it("returns a decoy salt for an empty email (no lookup)", async () => {
>     const res = await POST(req({ email: "" }));
>     expect(res.status).toBe(200);
>     expect((await res.json()).salt).toBe(await decoySalt("test-secret", ""));
>   });
> ```
> (The route already handles this: `email` is `""`, so `user` is `null` and it returns `decoySalt(secret, "")`.) Fold this into Task 5 Step 5 if you want the gap explicitly closed.
