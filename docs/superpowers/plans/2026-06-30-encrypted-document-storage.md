# Encrypted Document Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let owners upload/list/download/delete encrypted files (wills, deeds, scans) in the zero-knowledge vault, and let survivors retrieve them on `/recover`.

**Architecture:** A new `Document` encrypted-record type stored inline in Postgres with **two** AES-GCM blob pairs — small metadata (filename/type/size) and large file content. Files are encrypted client-side with the existing master key, so the server stores only ciphertext. Survivor recovery is automatic: the Slice-1 escrowed master key already decrypts anything; the claim flow just learns about document metadata, and a survivor endpoint serves content blobs on demand.

**Tech Stack:** Next.js 16 (App Router, TS strict), Prisma 6 → Railway Postgres, browser WebCrypto (AES-GCM via `src/lib/crypto.ts`), Vitest 4.

## Global Constraints

- **Zero-knowledge invariant:** the server persists only `{ metaCiphertext, metaIv, contentCiphertext, contentIv }` opaque blobs. Never plaintext, never the key. All encrypt/decrypt is client-side.
- **Per-file cap:** `MAX_FILE_BYTES = 5 * 1024 * 1024` (5 MB plaintext), enforced client-side before encrypting AND server-side on ciphertext length (`MAX_CONTENT_CIPHERTEXT_CHARS = 8 * 1024 * 1024`).
- **Host:** Node server on Railway — no 4.5 MB ingress limit (base64 JSON POST is fine). If ever moved to Vercel, switch upload to binary multipart or lower the cap.
- **Survivor endpoints fail closed with a generic 401** `{ error: "Could not unlock." }` on every failure (bad verifier, unknown email, unknown doc) — anti-enumeration, matching `survivor/claim`.
- **Migrations are committed as files** under `prisma/migrations/` and applied to **both** dev (`.env`) and test (`.env.test`) DBs.
- **Documents are immutable:** no `PUT`/rename. Edit = delete + re-upload.
- Verification gates per AGENTS.md: `npm test` · `npx tsc --noEmit` · `npm run build` · live e2e.

---

### Task 1: Binary-aware crypto (`encryptBytes` / `decryptBytes`)

**Files:**
- Modify: `src/lib/crypto.ts` (append two exports after `decryptItem`)
- Test: `src/lib/crypto.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: existing module-private `importAesKey`, `randomBytes`, `bytesToB64`, `b64ToBytes`, `IV_BYTES`, and exported `CryptoBytes`.
- Produces:
  - `encryptBytes(masterKey: CryptoBytes, bytes: CryptoBytes): Promise<{ ciphertext: string; iv: string }>`
  - `decryptBytes(masterKey: CryptoBytes, ciphertext: string, iv: string): Promise<CryptoBytes>`

- [ ] **Step 1: Write the failing test** — append to `src/lib/crypto.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/crypto.test.ts`
Expected: FAIL — `encryptBytes`/`decryptBytes` are not exported.

- [ ] **Step 3: Write minimal implementation** — append to `src/lib/crypto.ts`:

```ts
export async function encryptBytes(
  masterKey: CryptoBytes,
  bytes: CryptoBytes,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await importAesKey(masterKey);
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  return { ciphertext: bytesToB64(new Uint8Array(ct)), iv: bytesToB64(iv) };
}

export async function decryptBytes(
  masterKey: CryptoBytes,
  ciphertext: string,
  iv: string,
): Promise<CryptoBytes> {
  const key = await importAesKey(masterKey);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(iv) },
    key,
    b64ToBytes(ciphertext),
  );
  return new Uint8Array(pt);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/crypto.test.ts`
Expected: PASS (all crypto tests, old + new).

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/lib/crypto.ts src/lib/crypto.test.ts
git commit -m "feat(documents): binary-aware encryptBytes/decryptBytes"
```

---

### Task 2: Document domain lib (`src/lib/document.ts`)

**Files:**
- Create: `src/lib/document.ts`
- Test: `src/lib/document.test.ts`

**Interfaces:**
- Produces:
  - `interface DocumentMeta { filename: string; contentType: string; size: number }`
  - `const MAX_FILE_BYTES = 5 * 1024 * 1024`
  - `const MAX_CONTENT_CIPHERTEXT_CHARS = 8 * 1024 * 1024`
  - `serializeMeta(meta: DocumentMeta): string`
  - `parseMeta(json: string): DocumentMeta`
  - `formatFileSize(bytes: number): string`
  - `isAllowedType(contentType: string): boolean`

- [ ] **Step 1: Write the failing test** — create `src/lib/document.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  serializeMeta,
  parseMeta,
  formatFileSize,
  isAllowedType,
  MAX_FILE_BYTES,
  type DocumentMeta,
} from "./document";

describe("document meta", () => {
  it("round-trips serialize/parse", () => {
    const meta: DocumentMeta = { filename: "will.pdf", contentType: "application/pdf", size: 1234 };
    expect(parseMeta(serializeMeta(meta))).toEqual(meta);
  });

  it("parse throws on a malformed shape", () => {
    expect(() => parseMeta(JSON.stringify({ filename: "x" }))).toThrow();
    expect(() => parseMeta("not json")).toThrow();
  });

  it("formatFileSize is human readable", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(812)).toBe("812 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1.4 * 1024 * 1024)).toBe("1.4 MB");
  });

  it("allows documents/images and rejects others", () => {
    expect(isAllowedType("application/pdf")).toBe(true);
    expect(isAllowedType("image/png")).toBe(true);
    expect(isAllowedType("application/x-msdownload")).toBe(false);
    expect(isAllowedType("")).toBe(false);
  });

  it("exposes a 5 MB cap", () => {
    expect(MAX_FILE_BYTES).toBe(5 * 1024 * 1024);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/document.test.ts`
Expected: FAIL — module `./document` does not exist.

- [ ] **Step 3: Write minimal implementation** — create `src/lib/document.ts`:

```ts
export interface DocumentMeta {
  filename: string;
  contentType: string;
  size: number; // plaintext byte length, for display
}

/** Largest plaintext file we accept (validated in the browser before encrypting). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Server-side guard on stored ciphertext length (base64 of ~5 MB + AES overhead, with margin). */
export const MAX_CONTENT_CIPHERTEXT_CHARS = 8 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export function isAllowedType(contentType: string): boolean {
  return ALLOWED_CONTENT_TYPES.has(contentType);
}

export function serializeMeta(meta: DocumentMeta): string {
  return JSON.stringify({
    filename: meta.filename,
    contentType: meta.contentType,
    size: meta.size,
  });
}

export function parseMeta(json: string): DocumentMeta {
  const o = JSON.parse(json) as Record<string, unknown>;
  if (
    typeof o.filename !== "string" ||
    typeof o.contentType !== "string" ||
    typeof o.size !== "number"
  ) {
    throw new Error("Malformed document metadata.");
  }
  return { filename: o.filename, contentType: o.contentType, size: o.size };
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/document.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/lib/document.ts src/lib/document.test.ts
git commit -m "feat(documents): document meta domain lib (serialize/parse/format/allowlist)"
```

---

### Task 3: Prisma `Document` model + migration

**Files:**
- Modify: `prisma/schema.prisma` (add `Document` model + `documents` relation on `User`)
- Create: `prisma/migrations/<timestamp>_documents/migration.sql` (generated)

**Interfaces:**
- Produces: `prisma.document` delegate with fields `{ id, userId, metaCiphertext, metaIv, contentCiphertext, contentIv, createdAt }`; `User.documents` relation.

- [ ] **Step 1: Add the relation field to `User`** — in `prisma/schema.prisma`, inside `model User`, after the `survivorAccess` line add:

```prisma
  documents         Document[]
```

- [ ] **Step 2: Add the model** — append to `prisma/schema.prisma`:

```prisma
model Document {
  id                String   @id @default(cuid())
  userId            String
  metaCiphertext    String
  metaIv            String
  contentCiphertext String
  contentIv         String
  createdAt         DateTime @default(now())
  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

- [ ] **Step 3: Create + apply the migration to the DEV DB**

Run: `npx prisma migrate dev --name documents`
Expected: "The following migration(s) have been created and applied" + Prisma Client regenerated. (This writes `prisma/migrations/<ts>_documents/migration.sql`.)

- [ ] **Step 4: Apply the migration to the TEST DB**

Run: `npx dotenv -e .env.test -- prisma migrate deploy`
Expected: applies the new migration to the test database ("1 migration found … applied").

- [ ] **Step 5: Verify the client typechecks against the new model**

Run: `npx tsc --noEmit`
Expected: PASS (no usage yet, but confirms the generated client is valid).

- [ ] **Step 6: Commit (schema + migration files)**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(documents): add Document model + migration (dev + test)"
```

---

### Task 4: `/api/documents` route (list metadata + create)

**Files:**
- Create: `src/app/api/documents/route.ts`
- Test: `src/app/api/documents/route.test.ts`

**Interfaces:**
- Consumes: `requireUserId` (`@/lib/route-auth`), `readJsonBody` (`@/lib/http`), `MAX_CONTENT_CIPHERTEXT_CHARS` (`@/lib/document`), `prisma.document` (Task 3).
- Produces: `GET` → `{ documents: { id, metaCiphertext, metaIv, createdAt }[] }`; `POST` body `{ metaCiphertext, metaIv, contentCiphertext, contentIv }` → `{ id }` (201).

- [ ] **Step 1: Write the failing test** — create `src/app/api/documents/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUserId = vi.fn();
const findMany = vi.fn();
const create = vi.fn();

vi.mock("@/lib/route-auth", () => ({ requireUserId: () => requireUserId() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    document: {
      findMany: (...a: unknown[]) => findMany(...a),
      create: (...a: unknown[]) => create(...a),
    },
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
});

describe("/api/documents", () => {
  it("GET 401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("GET returns metadata only (no content)", async () => {
    requireUserId.mockResolvedValue("u1");
    findMany.mockResolvedValue([{ id: "d1", metaCiphertext: "mc", metaIv: "mi", createdAt: new Date(0) }]);
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.documents[0]).toMatchObject({ id: "d1", metaCiphertext: "mc", metaIv: "mi" });
    expect(JSON.stringify(data)).not.toContain("contentCiphertext");
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
      orderBy: { createdAt: "desc" },
      select: { id: true, metaCiphertext: true, metaIv: true, createdAt: true },
    });
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

  it("POST creates and returns the id", async () => {
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

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/documents/route.test.ts`
Expected: FAIL — `./route` does not exist.

- [ ] **Step 3: Write minimal implementation** — create `src/app/api/documents/route.ts`:

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/route-auth";
import { readJsonBody } from "@/lib/http";
import { MAX_CONTENT_CIPHERTEXT_CHARS } from "@/lib/document";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const documents = await prisma.document.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, metaCiphertext: true, metaIv: true, createdAt: true },
  });
  return NextResponse.json({ documents });
}

export async function POST(req: Request) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const metaCiphertext = typeof body.metaCiphertext === "string" ? body.metaCiphertext : "";
  const metaIv = typeof body.metaIv === "string" ? body.metaIv : "";
  const contentCiphertext = typeof body.contentCiphertext === "string" ? body.contentCiphertext : "";
  const contentIv = typeof body.contentIv === "string" ? body.contentIv : "";
  if (!metaCiphertext || !metaIv || !contentCiphertext || !contentIv) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }
  if (contentCiphertext.length > MAX_CONTENT_CIPHERTEXT_CHARS) {
    return NextResponse.json({ error: "File is too large." }, { status: 400 });
  }

  const created = await prisma.document.create({
    data: { userId, metaCiphertext, metaIv, contentCiphertext, contentIv },
    select: { id: true },
  });
  return NextResponse.json({ id: created.id }, { status: 201 });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/documents/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/app/api/documents/route.ts src/app/api/documents/route.test.ts
git commit -m "feat(documents): /api/documents list-metadata + create route"
```

---

### Task 5: `/api/documents/[id]` route (download content + delete)

**Files:**
- Create: `src/app/api/documents/[id]/route.ts`
- Test: `src/app/api/documents/[id]/route.test.ts`

**Interfaces:**
- Consumes: `requireUserId`, `prisma.document.findFirst`, `prisma.document.deleteMany`.
- Produces: `GET` → `{ contentCiphertext, contentIv }` (404 if not owner's); `DELETE` → `{ ok: true }` (404 if none deleted).

- [ ] **Step 1: Write the failing test** — create `src/app/api/documents/[id]/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUserId = vi.fn();
const findFirst = vi.fn();
const deleteMany = vi.fn();

vi.mock("@/lib/route-auth", () => ({ requireUserId: () => requireUserId() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    document: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      deleteMany: (...a: unknown[]) => deleteMany(...a),
    },
  },
}));

import { GET, DELETE } from "./route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://localhost/api/documents/d1");

beforeEach(() => {
  requireUserId.mockReset();
  findFirst.mockReset();
  deleteMany.mockReset();
});

describe("/api/documents/[id]", () => {
  it("GET 401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await GET(req(), ctx("d1"))).status).toBe(401);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("GET 404 when the document is not the user's", async () => {
    requireUserId.mockResolvedValue("u1");
    findFirst.mockResolvedValue(null);
    expect((await GET(req(), ctx("d1"))).status).toBe(404);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "d1", userId: "u1" },
      select: { contentCiphertext: true, contentIv: true },
    });
  });

  it("GET returns the content blob", async () => {
    requireUserId.mockResolvedValue("u1");
    findFirst.mockResolvedValue({ contentCiphertext: "cc", contentIv: "ci" });
    const res = await GET(req(), ctx("d1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ contentCiphertext: "cc", contentIv: "ci" });
  });

  it("DELETE 401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await DELETE(req(), ctx("d1"))).status).toBe(401);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("DELETE 404 when nothing was deleted", async () => {
    requireUserId.mockResolvedValue("u1");
    deleteMany.mockResolvedValue({ count: 0 });
    expect((await DELETE(req(), ctx("d1"))).status).toBe(404);
  });

  it("DELETE 200 when a row is removed", async () => {
    requireUserId.mockResolvedValue("u1");
    deleteMany.mockResolvedValue({ count: 1 });
    const res = await DELETE(req(), ctx("d1"));
    expect(res.status).toBe(200);
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "d1", userId: "u1" } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/api/documents/[id]/route.test.ts"`
Expected: FAIL — `./route` does not exist.

- [ ] **Step 3: Write minimal implementation** — create `src/app/api/documents/[id]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/route-auth";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { id } = await ctx.params;
  const doc = await prisma.document.findFirst({
    where: { id, userId },
    select: { contentCiphertext: true, contentIv: true },
  });
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json(doc);
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { id } = await ctx.params;
  const { count } = await prisma.document.deleteMany({ where: { id, userId } });
  if (count === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run "src/app/api/documents/[id]/route.test.ts"`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add "src/app/api/documents/[id]/route.ts" "src/app/api/documents/[id]/route.test.ts"
git commit -m "feat(documents): /api/documents/[id] content download + delete"
```

---

### Task 6: `/api/survivor/document` route (survivor content download)

**Files:**
- Create: `src/app/api/survivor/document/route.ts`
- Test: `src/app/api/survivor/document/route.test.ts`

**Interfaces:**
- Consumes: `verifyVerifier` (`@/lib/auth`), `readJsonBody`, `prisma.user.findUnique`, `prisma.document.findFirst`.
- Produces: `POST` body `{ email, survivorAuthVerifier, documentId }` → `{ contentCiphertext, contentIv }`; generic 401 on every failure.

- [ ] **Step 1: Write the failing test** — create `src/app/api/survivor/document/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const findFirst = vi.fn();
const verifyVerifier = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: (...a: unknown[]) => findUnique(...a) },
    document: { findFirst: (...a: unknown[]) => findFirst(...a) },
  },
}));
vi.mock("@/lib/auth", () => ({ verifyVerifier: (...a: unknown[]) => verifyVerifier(...a) }));

import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://localhost/api/survivor/document", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ok = { email: "a@b.com", survivorAuthVerifier: "v", documentId: "d1" };
const userRow = { id: "u1", survivorAccess: { survivorAuthVerifierHash: "hash" } };

beforeEach(() => {
  findUnique.mockReset();
  findFirst.mockReset();
  verifyVerifier.mockReset();
});

describe("/api/survivor/document", () => {
  it("401 generic when fields are missing", async () => {
    const res = await POST(req({ email: "a@b.com" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Could not unlock." });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("401 when no survivor access", async () => {
    findUnique.mockResolvedValue(null);
    expect((await POST(req(ok))).status).toBe(401);
  });

  it("401 when the verifier does not match", async () => {
    findUnique.mockResolvedValue(userRow);
    verifyVerifier.mockResolvedValue(false);
    expect((await POST(req(ok))).status).toBe(401);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("401 (not 404) when the document is unknown", async () => {
    findUnique.mockResolvedValue(userRow);
    verifyVerifier.mockResolvedValue(true);
    findFirst.mockResolvedValue(null);
    const res = await POST(req(ok));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Could not unlock." });
  });

  it("returns the content blob on a correct verifier + owned doc", async () => {
    findUnique.mockResolvedValue(userRow);
    verifyVerifier.mockResolvedValue(true);
    findFirst.mockResolvedValue({ contentCiphertext: "cc", contentIv: "ci" });
    const res = await POST(req(ok));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ contentCiphertext: "cc", contentIv: "ci" });
    expect(verifyVerifier).toHaveBeenCalledWith("v", "hash");
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "d1", userId: "u1" },
      select: { contentCiphertext: true, contentIv: true },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/survivor/document/route.test.ts`
Expected: FAIL — `./route` does not exist.

- [ ] **Step 3: Write minimal implementation** — create `src/app/api/survivor/document/route.ts`:

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyVerifier } from "@/lib/auth";
import { readJsonBody } from "@/lib/http";

const denied = () => NextResponse.json({ error: "Could not unlock." }, { status: 401 });

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return denied();

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const survivorAuthVerifier =
    typeof body.survivorAuthVerifier === "string" ? body.survivorAuthVerifier : "";
  const documentId = typeof body.documentId === "string" ? body.documentId : "";
  if (!email || !survivorAuthVerifier || !documentId) return denied();

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, survivorAccess: { select: { survivorAuthVerifierHash: true } } },
  });
  if (!user || !user.survivorAccess) return denied();

  const ok = await verifyVerifier(survivorAuthVerifier, user.survivorAccess.survivorAuthVerifierHash);
  if (!ok) return denied();

  const doc = await prisma.document.findFirst({
    where: { id: documentId, userId: user.id },
    select: { contentCiphertext: true, contentIv: true },
  });
  if (!doc) return denied();
  return NextResponse.json(doc);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/survivor/document/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/app/api/survivor/document/route.ts src/app/api/survivor/document/route.test.ts
git commit -m "feat(documents): /api/survivor/document on-demand content for survivors"
```

---

### Task 7: Claim route + api-client extension (document metadata)

**Files:**
- Modify: `src/app/api/survivor/claim/route.ts` (add `documents` to include + response)
- Modify: `src/app/api/survivor/claim/route.test.ts` (assert documents metadata present, content absent)
- Modify: `src/lib/api-client.ts` (types + 5 new methods)

**Interfaces:**
- Produces (api-client):
  - `type DocumentMetaRow = { id: string; metaCiphertext: string; metaIv: string }`
  - `SurvivorRecords` gains `documents: DocumentMetaRow[]`
  - `listDocuments(): Promise<{ documents: DocumentMetaRow[] }>`
  - `addDocument(p: { metaCiphertext: string; metaIv: string; contentCiphertext: string; contentIv: string }): Promise<{ id: string }>`
  - `getDocumentContent(id: string): Promise<{ contentCiphertext: string; contentIv: string }>`
  - `deleteDocument(id: string): Promise<{ ok: true }>`
  - `survivorDocument(email: string, survivorAuthVerifier: string, documentId: string): Promise<{ contentCiphertext: string; contentIv: string }>`

- [ ] **Step 1: Update the claim route test** — in `src/app/api/survivor/claim/route.test.ts`, add a `documents` array to `userRow` (after the `beneficiaries: []` line):

```ts
  documents: [{ id: "d1", metaCiphertext: "dmc", metaIv: "dmi", createdAt: new Date(0) }],
```

And in the "returns escrow + all records" test, change the expected `records` object to include documents and assert no content leaks. Replace that test's body with:

```ts
  it("returns escrow + all records on a correct verifier", async () => {
    findUnique.mockResolvedValue(userRow);
    verifyVerifier.mockResolvedValue(true);
    const res = await POST(req({ email: "a@b.com", survivorAuthVerifier: "right" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.escrow).toEqual({ ciphertext: "EC", iv: "EI" });
    expect(data.records.documents).toEqual([
      { id: "d1", metaCiphertext: "dmc", metaIv: "dmi", createdAt: new Date(0).toISOString() },
    ]);
    expect(JSON.stringify(data.records.documents)).not.toContain("contentCiphertext");
    expect(verifyVerifier).toHaveBeenCalledWith("right", "hash");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/survivor/claim/route.test.ts`
Expected: FAIL — response has no `records.documents`.

- [ ] **Step 3: Update the claim route** — in `src/app/api/survivor/claim/route.ts`:

Add a documents include inside the `include: {` block (after `beneficiaries: blobSelect,`):

```ts
      documents: {
        select: { id: true, metaCiphertext: true, metaIv: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
```

Add `documents` to the response `records` object (after `beneficiaries: user.beneficiaries,`):

```ts
      documents: user.documents,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/survivor/claim/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend the api-client** — in `src/lib/api-client.ts`:

Add the row type and extend `SurvivorRecords` (after the `SurvivorBlob` type):

```ts
export type DocumentMetaRow = { id: string; metaCiphertext: string; metaIv: string };
```

Inside the `SurvivorRecords` type, add:

```ts
  documents: DocumentMetaRow[];
```

Add these methods to the `api` object (before the closing `};`):

```ts
  listDocuments: async () => {
    const res = await fetch("/api/documents");
    if (!res.ok) throw new Error("We couldn't load your documents.");
    return res.json() as Promise<{ documents: DocumentMetaRow[] }>;
  },
  addDocument: (p: {
    metaCiphertext: string;
    metaIv: string;
    contentCiphertext: string;
    contentIv: string;
  }) => post<{ id: string }>("/api/documents", p),
  getDocumentContent: async (id: string) => {
    const res = await fetch(`/api/documents/${id}`);
    if (!res.ok) throw new Error("We couldn't open that file.");
    return res.json() as Promise<{ contentCiphertext: string; contentIv: string }>;
  },
  deleteDocument: async (id: string) => {
    const res = await fetch(`/api/documents/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `Request failed (${res.status})`);
    }
    return res.json() as Promise<{ ok: true }>;
  },
  survivorDocument: (email: string, survivorAuthVerifier: string, documentId: string) =>
    post<{ contentCiphertext: string; contentIv: string }>("/api/survivor/document", {
      email,
      survivorAuthVerifier,
      documentId,
    }),
```

- [ ] **Step 6: Typecheck + full unit suite + commit**

```bash
npx tsc --noEmit
npm test
git add src/app/api/survivor/claim/route.ts src/app/api/survivor/claim/route.test.ts src/lib/api-client.ts
git commit -m "feat(documents): claim returns document metadata; api-client document methods"
```

---

### Task 8: `useDocuments` hook

**Files:**
- Create: `src/app/providers/useDocuments.ts`

**Interfaces:**
- Consumes: `useKey` (`@/app/providers/KeyProvider`), `api` (Task 7), `encryptItem`/`decryptItem`/`encryptBytes`/`decryptBytes`/`CryptoBytes` (`@/lib/crypto`), `document` lib (Task 2).
- Produces: `useDocuments()` returning `{ items: DocumentItem[]; error: string; loaded: boolean; upload(file: File): Promise<boolean>; download(id: string, meta: DocumentMeta): Promise<void>; remove(id: string): Promise<boolean>; masterKey }` where `DocumentItem = { id: string; meta: DocumentMeta | null }`.

> No unit test: the codebase has no React component/hook test harness (no jsdom / testing-library in devDeps). Behavior is proven by Task 11 (live e2e) and gated here by `tsc` + `build`.

- [ ] **Step 1: Create the hook** — create `src/app/providers/useDocuments.ts`:

```ts
"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { useKey } from "@/app/providers/KeyProvider";
import {
  encryptItem,
  decryptItem,
  encryptBytes,
  decryptBytes,
  type CryptoBytes,
} from "@/lib/crypto";
import {
  type DocumentMeta,
  serializeMeta,
  parseMeta,
  isAllowedType,
  formatFileSize,
  MAX_FILE_BYTES,
} from "@/lib/document";

export interface DocumentItem {
  id: string;
  meta: DocumentMeta | null; // null = this row failed to decrypt
}

function saveBytes(bytes: CryptoBytes, filename: string, contentType: string) {
  const blob = new Blob([bytes], { type: contentType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "document";
  a.click();
  URL.revokeObjectURL(url);
}

export function useDocuments() {
  const router = useRouter();
  const { masterKey } = useKey();
  const [items, setItems] = useState<DocumentItem[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!masterKey) return;
    setError("");
    const { documents } = await api.listDocuments();
    const decrypted = await Promise.all(
      documents.map(async (d) => {
        try {
          return { id: d.id, meta: parseMeta(await decryptItem(masterKey, d.metaCiphertext, d.metaIv)) };
        } catch {
          return { id: d.id, meta: null };
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
    load().catch(() =>
      setError("We couldn't load your documents. Please try unlocking again."),
    );
  }, [masterKey, load, router]);

  const upload = useCallback(
    async (file: File): Promise<boolean> => {
      if (!masterKey) return false;
      setError("");
      if (file.size > MAX_FILE_BYTES) {
        setError(`That file is ${formatFileSize(file.size)}. The limit is ${formatFileSize(MAX_FILE_BYTES)}.`);
        return false;
      }
      if (!isAllowedType(file.type)) {
        setError("That file type isn't supported.");
        return false;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer()) as CryptoBytes;
        const content = await encryptBytes(masterKey, bytes);
        const meta = await encryptItem(
          masterKey,
          serializeMeta({ filename: file.name, contentType: file.type, size: file.size }),
        );
        await api.addDocument({
          metaCiphertext: meta.ciphertext,
          metaIv: meta.iv,
          contentCiphertext: content.ciphertext,
          contentIv: content.iv,
        });
        await load();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "We couldn't save that file.");
        return false;
      }
    },
    [masterKey, load],
  );

  const download = useCallback(
    async (id: string, meta: DocumentMeta): Promise<void> => {
      if (!masterKey) return;
      setError("");
      try {
        const { contentCiphertext, contentIv } = await api.getDocumentContent(id);
        const bytes = await decryptBytes(masterKey, contentCiphertext, contentIv);
        saveBytes(bytes, meta.filename, meta.contentType);
      } catch (err) {
        setError(err instanceof Error ? err.message : "We couldn't open that file.");
      }
    },
    [masterKey],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      setError("");
      try {
        await api.deleteDocument(id);
        await load();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "We couldn't delete that.");
        return false;
      }
    },
    [load],
  );

  return { items, error, loaded, upload, download, remove, masterKey };
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/app/providers/useDocuments.ts
git commit -m "feat(documents): useDocuments hook (gate/load/upload/download/delete)"
```

---

### Task 9: `/documents` page + nav link

**Files:**
- Create: `src/app/documents/page.tsx`
- Modify: `src/components/AppNav.tsx` (add nav link)

**Interfaces:**
- Consumes: `useDocuments` (Task 8), `formatFileSize`/`MAX_FILE_BYTES` (Task 2), `AppNav`, `LegacyMark` (`@/components/Logo`).

> Gated by `tsc` + `build`; behavior proven by Task 11.

- [ ] **Step 1: Create the page** — create `src/app/documents/page.tsx`:

```tsx
"use client";

import { useState, useRef } from "react";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { useDocuments } from "@/app/providers/useDocuments";
import { formatFileSize, MAX_FILE_BYTES } from "@/lib/document";

export default function DocumentsPage() {
  const { items, error, loaded, upload, download, remove, masterKey } = useDocuments();
  const [busy, setBusy] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    await upload(file);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  if (!masterKey) return null;

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Documents</h1>
        <p className="subtle">
          Each file is encrypted on your device before it leaves. Limit{" "}
          {formatFileSize(MAX_FILE_BYTES)} per file.
        </p>

        <label htmlFor="file">Upload a document</label>
        <input id="file" ref={inputRef} type="file" onChange={onChange} disabled={busy} />
        {busy && <p className="subtle">Encrypting and uploading…</p>}

        {error && <p className="error">{error}</p>}

        {loaded && items.length === 0 && (
          <p className="subtle">No documents yet. Upload your first above.</p>
        )}
        {items.some((it) => it.meta === null) && (
          <p className="subtle">We couldn&apos;t unlock some documents.</p>
        )}

        {items.map(
          (it) =>
            it.meta && (
              <div className="item" key={it.id}>
                <strong>{it.meta.filename || "Untitled"}</strong>
                <div className="meta">
                  {it.meta.contentType || "file"} · {formatFileSize(it.meta.size)}
                </div>
                <div className="row">
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() => download(it.id, it.meta!)}
                  >
                    Download
                  </button>
                  {confirmingId === it.id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmingId(null);
                          remove(it.id);
                        }}
                      >
                        Confirm delete
                      </button>
                      <button
                        type="button"
                        className="linkbtn"
                        onClick={() => setConfirmingId(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="linkbtn"
                      onClick={() => setConfirmingId(it.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ),
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Add the nav link** — in `src/components/AppNav.tsx`, add after the Beneficiaries link:

```tsx
        <Link href="/documents">Documents</Link>
```

- [ ] **Step 3: Typecheck + build + commit**

```bash
npx tsc --noEmit
npm run build
git add src/app/documents/page.tsx src/components/AppNav.tsx
git commit -m "feat(documents): /documents owner page + nav link"
```

---

### Task 10: `/recover` page — Documents section (survivor download)

**Files:**
- Modify: `src/app/recover/page.tsx` (keep master key + email + verifier in state; decrypt document metadata; per-file download)

**Interfaces:**
- Consumes: `api.survivorDocument` + `SurvivorRecords.documents` (Task 7), `decryptBytes`/`CryptoBytes` (Task 1), `parseMeta`/`DocumentMeta` (Task 2).

> Gated by `tsc` + `build`; behavior proven by Task 11.

- [ ] **Step 1: Replace `src/app/recover/page.tsx`** with the version below (adds documents handling; keeps a `session` for on-demand survivor downloads):

```tsx
"use client";

import { useState } from "react";
import { BrandHeader } from "@/components/Logo";
import { api, type SurvivorRecords } from "@/lib/api-client";
import { deriveSurvivorAuthVerifier, recoverMasterKey } from "@/lib/survivor-crypto";
import { decryptItem, decryptBytes, type CryptoBytes } from "@/lib/crypto";
import { parseAccount, type Account } from "@/lib/account";
import { parseBill, type Bill } from "@/lib/bill";
import { parseLoan, type Loan } from "@/lib/loan";
import { parseBeneficiary, type Beneficiary } from "@/lib/beneficiary";
import { parseMeta, type DocumentMeta } from "@/lib/document";

type DocEntry = { id: string; meta: DocumentMeta };

type Decrypted = {
  accounts: Account[];
  bills: Bill[];
  loans: Loan[];
  beneficiaries: Beneficiary[];
  notes: string[];
  documents: DocEntry[];
  obituary: string | null;
};

type Session = { email: string; verifier: string; mk: CryptoBytes };

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

export default function RecoverPage() {
  const [email, setEmail] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<Decrypted | null>(null);
  const [session, setSession] = useState<Session | null>(null);

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
      setSession({ email: email.trim().toLowerCase(), verifier, mk });
      setData(await decryptAll(mk, claim.records));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function downloadDoc(doc: DocEntry) {
    if (!session) return;
    setError("");
    try {
      const { contentCiphertext, contentIv } = await api.survivorDocument(
        session.email,
        session.verifier,
        doc.id,
      );
      const bytes = await decryptBytes(session.mk, contentCiphertext, contentIv);
      const blob = new Blob([bytes], {
        type: doc.meta.contentType || "application/octet-stream",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.meta.filename || "document";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("We couldn't open that file. Please try again.");
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
          {error && <p className="error">{error}</p>}

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

          {data.documents.length > 0 && (
            <section>
              <h2>Documents</h2>
              {data.documents.map((d) => (
                <div className="item" key={d.id}>
                  <strong>{d.meta.filename || "Untitled"}</strong>
                  <div className="meta">{d.meta.contentType || "file"}</div>
                  <div className="row no-print">
                    <button type="button" className="linkbtn" onClick={() => downloadDoc(d)}>
                      Download
                    </button>
                  </div>
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

- [ ] **Step 2: Typecheck + build + commit**

```bash
npx tsc --noEmit
npm run build
git add src/app/recover/page.tsx
git commit -m "feat(documents): survivor recover page lists + downloads documents"
```

---

### Task 11: Live e2e — document round-trip + no-plaintext proof

**Files:**
- Modify: `e2e.spec.ts` (add one `it(...)` inside the existing `describe("walking skeleton (live)")`)

**Interfaces:**
- Consumes: live dev server at `http://localhost:3000` + dev DB; `encryptItem`/`decryptItem`/`encryptBytes`/`decryptBytes` (`@/lib/crypto`), `serializeMeta`/`parseMeta`/`type DocumentMeta` (`@/lib/document`), `buildSurvivorEscrow`/`deriveSurvivorAuthVerifier`/`recoverMasterKey` (already imported).

- [ ] **Step 1: Add the imports** — in `e2e.spec.ts`, after the existing `survivor-crypto` import block, add:

```ts
import { encryptBytes, decryptBytes } from "@/lib/crypto";
import { serializeMeta, parseMeta, type DocumentMeta } from "@/lib/document";
```

- [ ] **Step 2: Add the test** — inside the `describe("walking skeleton (live)")` block, append:

```ts
  it("stores an encrypted document and a survivor downloads it (no plaintext stored)", async () => {
    const dEmail = `e2e-doc-${Date.now()}@example.com`;
    const pass = "document-owner-passphrase-123";

    // register + login as owner
    const salt = generateSalt();
    const mk = await deriveMasterKey(pass, salt);
    const av = await deriveAuthVerifier(mk, pass);
    await fetch(`${BASE}/api/auth/register`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: dEmail, salt, authVerifier: av }),
    });
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: dEmail, authVerifier: av }),
    });
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

    // unauthenticated list is rejected
    expect((await fetch(`${BASE}/api/documents`)).status).toBe(401);

    // encrypt a small binary "file" (a fake PDF header + bytes) + its metadata
    const fileBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 1, 2, 250, 255, 128, 7, 13]);
    const SECRET_NAME = "last-will-and-testament.pdf";
    const meta: DocumentMeta = { filename: SECRET_NAME, contentType: "application/pdf", size: fileBytes.length };
    const content = await encryptBytes(mk, fileBytes);
    const metaBlob = await encryptItem(mk, serializeMeta(meta));
    const add = await fetch(`${BASE}/api/documents`, {
      method: "POST", headers: { ...json, cookie },
      body: JSON.stringify({
        metaCiphertext: metaBlob.ciphertext, metaIv: metaBlob.iv,
        contentCiphertext: content.ciphertext, contentIv: content.iv,
      }),
    });
    expect(add.status).toBe(201);
    const { id: docId } = await add.json();

    // owner list returns metadata only; owner content download round-trips byte-for-byte
    const listRes = await fetch(`${BASE}/api/documents`, { headers: { cookie } });
    const { documents } = await listRes.json();
    expect(documents).toHaveLength(1);
    expect(JSON.stringify(documents)).not.toContain("contentCiphertext");
    expect(parseMeta(await decryptItem(mk, documents[0].metaCiphertext, documents[0].metaIv))).toEqual(meta);

    const ownerContent = await fetch(`${BASE}/api/documents/${docId}`, { headers: { cookie } });
    expect(ownerContent.status).toBe(200);
    const oc = await ownerContent.json();
    expect(Array.from(await decryptBytes(mk, oc.contentCiphertext, oc.contentIv))).toEqual(Array.from(fileBytes));

    // --- ARM survivor access, then a survivor recovers + downloads the document ---
    const arm = await buildSurvivorEscrow(mk);
    await fetch(`${BASE}/api/survivor`, {
      method: "POST", headers: { ...json, cookie },
      body: JSON.stringify({
        survivorSalt: arm.survivorSalt, survivorAuthVerifier: arm.survivorAuthVerifier,
        escrowCiphertext: arm.escrowCiphertext, escrowIv: arm.escrowIv,
      }),
    });

    const { salt: survivorSalt } = await (await fetch(`${BASE}/api/survivor/salt`, {
      method: "POST", headers: json, body: JSON.stringify({ email: dEmail }),
    })).json();
    const verifier = await deriveSurvivorAuthVerifier(arm.recoveryCode, survivorSalt);

    const claim = await (await fetch(`${BASE}/api/survivor/claim`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: dEmail, survivorAuthVerifier: verifier }),
    })).json();
    expect(claim.records.documents).toHaveLength(1);
    expect(JSON.stringify(claim.records.documents)).not.toContain("contentCiphertext");
    const recovered = await recoverMasterKey(arm.recoveryCode, survivorSalt, claim.escrow.ciphertext, claim.escrow.iv);
    const survivorDocId = claim.records.documents[0].id;

    // wrong verifier is rejected at the survivor content endpoint
    const badDoc = await fetch(`${BASE}/api/survivor/document`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: dEmail, survivorAuthVerifier: "wrong", documentId: survivorDocId }),
    });
    expect(badDoc.status).toBe(401);

    // correct survivor fetch returns content that decrypts to the original bytes
    const survDoc = await fetch(`${BASE}/api/survivor/document`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: dEmail, survivorAuthVerifier: verifier, documentId: survivorDocId }),
    });
    expect(survDoc.status).toBe(200);
    const sc = await survDoc.json();
    expect(Array.from(await decryptBytes(recovered, sc.contentCiphertext, sc.contentIv))).toEqual(Array.from(fileBytes));

    // --- ZERO-KNOWLEDGE: stored row leaks neither the filename nor the file bytes ---
    const row = await db.document.findFirst({ where: { user: { email: dEmail } } });
    expect(row).toBeTruthy();
    expect(row!.metaCiphertext).not.toContain(SECRET_NAME);
    expect(row!.metaCiphertext).not.toContain("last-will");
    expect(row!.contentCiphertext).not.toContain("%PDF");

    // cleanup
    await db.user.delete({ where: { email: dEmail } });
  }, 60_000);
```

- [ ] **Step 3: Run the live e2e (requires `npm run dev` running against the dev DB)**

Run: `npx vitest run --config vitest.e2e.config.ts`
Expected: PASS — all prior e2e specs plus the new document round-trip (no-plaintext proof for filename and bytes).

- [ ] **Step 4: Commit**

```bash
git add e2e.spec.ts
git commit -m "test(documents): live e2e — document round-trip + survivor download + no-plaintext proof"
```

---

## Self-Review

**Spec coverage:**
- ZK invariant (metadata + content blobs only) → Tasks 3–7, proven in 11. ✓
- Binary-aware crypto (no double-base64) → Task 1. ✓
- Domain lib (meta serialize/parse, cap, format, allowlist) → Task 2. ✓
- 5 MB cap client + server → Task 2 (`MAX_FILE_BYTES`, `MAX_CONTENT_CIPHERTEXT_CHARS`), enforced in hook (Task 8) + route (Task 4). ✓
- Bespoke routes: list/create (4), content/delete (5), survivor content (6). ✓
- Claim + api-client metadata (7). ✓
- `useDocuments` hook (8), `/documents` page + nav (9), recover documents section (10). ✓
- Generic-401 survivor fail-closed (6, incl. unknown-doc → 401). ✓
- Migration to dev + test, committed (3). ✓
- Tests: unit (1,2,4,5,6,7), live e2e (11). ✓
- Immutable (no PUT) → honored (no PUT route/method anywhere). ✓
- Risk note (Vercel body limit) → captured in Global Constraints. ✓

**Placeholder scan:** none — every code/test step contains complete content.

**Type consistency:** `DocumentMeta {filename, contentType, size}`, `DocumentMetaRow {id, metaCiphertext, metaIv}`, `encryptBytes`/`decryptBytes`, `MAX_FILE_BYTES`/`MAX_CONTENT_CIPHERTEXT_CHARS`, `useDocuments` return shape, and `api.*` method names are used identically across Tasks 1–11. Claim include uses `metaCiphertext/metaIv` (not `ciphertext/iv`) consistently. ✓
