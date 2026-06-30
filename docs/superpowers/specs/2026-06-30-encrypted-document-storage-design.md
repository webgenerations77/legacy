# Slice 2 — Encrypted Document Storage (Design Spec)

**Sprint 4, Slice 2.** Date: 2026-06-30. Branch: `sprint4-survivor-mode` (continues Sprint 4 work).

## Goal

Let owners upload, list, download, and delete arbitrary files (wills, deeds, scans, PDFs,
images) inside the zero-knowledge vault, and let survivors retrieve those files on the
public `/recover` page. Files are encrypted client-side with the existing master key, so
the server only ever stores ciphertext — the ZK invariant is preserved, and survivor
recovery comes "for free" because the escrowed master key already decrypts anything
encrypted with it.

## Locked design decisions

These were settled during brainstorming:

1. **Storage:** encrypted bytes live **inline in Postgres** (base64 string in a `Document`
   row), exactly like every other record. No external object storage. This keeps survivor
   recovery automatic and ZK trivially intact.
2. **Blob layout:** **split** into two encrypted pairs — a small **metadata** blob
   (filename, content-type, size) and a large **content** blob (the file bytes). The list
   endpoint returns metadata only, so rendering the document list is cheap; file bytes
   download only when a specific document is opened.
3. **Survivor retrieval:** **on-demand per file.** The claim response carries document
   *metadata only*; the recover page lists documents and fetches each file's content blob
   individually from a survivor-authenticated endpoint.
4. **Per-file cap:** **5 MB** (plaintext), enforced client-side before encrypting and
   server-side on ciphertext length.
5. **Host:** the app runs as a **Node server on Railway** (confirmed). There is no 4.5 MB
   serverless ingress limit, so a ~6.7 MB base64 JSON POST is fine. **Risk note:** if the
   app ever moves to Vercel (4.5 MB function body cap), document upload must switch to
   binary `multipart/form-data` or the cap must drop to ~3 MB raw. Documented here so the
   constraint isn't lost.

## Zero-knowledge invariant

The server persists only `{ metaCiphertext, metaIv, contentCiphertext, contentIv }` —
opaque AES-GCM blobs keyed by the browser-derived master key. No plaintext filename, no
plaintext bytes, no key. Survivors decrypt using the master key unwrapped from the Slice-1
escrow (`AES-GCM(survivorKey, masterKey)`). Nothing about documents weakens the invariant.

## Components

### 1. Crypto addition — binary-aware encrypt/decrypt (`src/lib/crypto.ts`)

`encryptItem` runs plaintext through `TextEncoder`; feeding it base64-of-file would
double-base64 (~1.77× bloat). Add two functions that operate on raw bytes:

```ts
export async function encryptBytes(
  masterKey: CryptoBytes,
  bytes: CryptoBytes,
): Promise<{ ciphertext: string; iv: string }>; // AES-GCM, base64 ciphertext once (~1.33×)

export async function decryptBytes(
  masterKey: CryptoBytes,
  ciphertext: string,
  iv: string,
): Promise<CryptoBytes>;
```

Same AES-GCM(masterKey) construction as `encryptItem`/`decryptItem`, just without the
text codec. Unit-tested round-trip (bytes in === bytes out, including binary/non-UTF8
content). The existing string helpers are untouched.

### 2. Domain lib — `src/lib/document.ts`

Pure, unit-tested. No I/O, no crypto.

```ts
export interface DocumentMeta {
  filename: string;
  contentType: string;
  size: number; // plaintext byte length, for display
}

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function serializeMeta(meta: DocumentMeta): string; // JSON.stringify
export function parseMeta(json: string): DocumentMeta;       // JSON.parse + shape guard
export function formatFileSize(bytes: number): string;       // "1.4 MB", "812 KB"
export function isAllowedType(contentType: string): boolean; // allowlist below
```

**Allowed content types** (allowlist; reject others client-side with a clear message):
PDF (`application/pdf`), images (`image/png`, `image/jpeg`, `image/gif`, `image/webp`,
`image/heic`), plain text (`text/plain`), and common Office docs
(`application/msword`, `.docx`, `.xls`, `.xlsx` MIME types). The allowlist is a UX guard,
not a security boundary (the server stores opaque ciphertext regardless).

### 3. Prisma model + migration

```prisma
model Document {
  id                String   @id @default(cuid())
  userId            String
  metaCiphertext    String
  metaIv            String
  contentCiphertext String   // base64 of AES-GCM(masterKey, file bytes)
  contentIv         String
  createdAt         DateTime @default(now())
  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

Add `documents Document[]` to `User`. No plaintext `size` column — the cap is enforced on
ciphertext length, and the display size lives inside the encrypted metadata. One migration,
applied to **both** dev (`.env`) and test (`.env.test`) DBs, committed as files under
`prisma/migrations/`. (Per AGENTS.md: confirm before running against any non-local env; the
GitHub-connected pipeline applies committed migrations.)

### 4. Routes

`Document` has two blob pairs and an on-demand content fetch, so it does **not** use the
generic `createEncryptedRecordRoute` / `createEncryptedRecordItemRoute` factories. It gets
bespoke handlers that follow the same auth/validation conventions (`requireUser`,
`readJsonBody`, generic-401 for survivor paths).

- **`src/app/api/documents/route.ts`**
  - `GET` — list metadata only: `{ documents: [{ id, metaCiphertext, metaIv, createdAt }] }`,
    ordered `createdAt desc`, scoped to the session user. 401 if not signed in.
  - `POST` — create. Body `{ metaCiphertext, metaIv, contentCiphertext, contentIv }`. Reject
    (400) if any field missing or if `contentCiphertext.length` exceeds the cap bound
    (`MAX_FILE_BYTES` → base64 ≈ ×1.4 ceiling, e.g. `7 * 1024 * 1024` chars). Returns
    `{ id }`, 201.
- **`src/app/api/documents/[id]/route.ts`**
  - `GET` — owner downloads one content blob: `{ contentCiphertext, contentIv }` for that
    `id` + `userId`. 404 if not found / not theirs. 401 if not signed in.
  - `DELETE` — owner deletes (`deleteMany` on `id` + `userId`). 404 if no row deleted.
  - **No `PUT`.** Documents are immutable: editing = delete + re-upload. (YAGNI; rename can
    be a later follow-up.)
- **`src/app/api/survivor/document/route.ts`**
  - `POST` — body `{ email, survivorAuthVerifier, documentId }`. Verifies via the **same
    generic-401 path** as `survivor/claim` (look up user + `survivorAccess`, `verifyVerifier`
    against `survivorAuthVerifierHash`; any failure → `{ error: "Could not unlock." }` 401).
    On success, return `{ contentCiphertext, contentIv }` for that document owned by that
    user. No session required (survivors have no account).

### 5. Claim route + api-client

- **`src/app/api/survivor/claim/route.ts`** — add `documents` to the `include` with
  `select: { id, metaCiphertext, metaIv, createdAt }` (metadata only — **never** content),
  and add `records.documents` to the response.
- **`src/lib/api-client.ts`** — extend `SurvivorRecords` with
  `documents: { id, metaCiphertext, metaIv }[]`, and add:
  - `listDocuments()`, `addDocument({ metaCiphertext, metaIv, contentCiphertext, contentIv })`,
    `getDocumentContent(id)`, `deleteDocument(id)`
  - `survivorDocument(email, survivorAuthVerifier, documentId)`

### 6. Owner UI

- **`src/app/providers/useDocuments.ts`** — a hook mirroring `useEncryptedRecords` but for
  the split shape and file handling. Responsibilities: gate on `masterKey` (redirect
  `/unlock`); load + decrypt metadata list; `upload(file)` (validate size/type → read bytes
  → `encryptBytes(content)` + `encryptItem(serializeMeta)` → POST → reload);
  `download(id, meta)` (GET content → `decryptBytes` → `Blob` → trigger save with original
  filename + content-type); `remove(id)`. Exposes `{ items, error, loaded, upload, download,
  remove, masterKey }`. Holds `serialize`/`parse` analogues stably (module-level functions),
  matching the existing hook's ref discipline.
- **`src/app/documents/page.tsx`** — bespoke page consuming `useDocuments`:
  - Upload form: `<input type="file">`; on submit validate (size ≤ cap, allowed type) and
    show inline errors; busy state during encrypt+upload.
  - List: filename, type, `formatFileSize(size)`, date; per-row **Download** and **Delete**
    buttons; empty state; "couldn't unlock some documents" note for rows that fail to
    decrypt (mirrors existing pages). Calm brand styling consistent with other pages
    (`card`, `AppNav`, `LegacyMark`).
- **`src/components/AppNav.tsx`** — add `<Link href="/documents">Documents</Link>`.

### 7. Survivor UI — `src/app/recover/page.tsx`

- Keep the recovered `masterKey` in component state (currently discarded after
  `decryptAll`) so content can be decrypted on demand.
- Decrypt document **metadata** from `claim.records.documents` into a filename list.
- Add a **Documents** section: each entry shows filename + size and a **Download** button
  that calls `api.survivorDocument(email, verifier, doc.id)`, `decryptBytes` with the held
  master key, and triggers a browser download. Read-only, on-demand, no bulk dump.

## Testing

- **Unit:** `document.test.ts` (meta serialize/parse round-trip + shape guard,
  `formatFileSize`, `isAllowedType`, `MAX_FILE_BYTES`); `crypto` `encryptBytes`/`decryptBytes`
  round-trip incl. binary content.
- **Route tests:** documents `GET`/`POST` (401 unauth, 400 missing/oversized, 201 + no
  plaintext stored), `[id]` `GET`/`DELETE` (401, 404 cross-user, success), `survivor/document`
  (generic-401 on bad/empty verifier and unknown email, success returns content). Update the
  claim route test to assert `records.documents` carries metadata and **no** content fields.
- **Live e2e** (`vitest.e2e.config.ts`, not in `npm test`): upload a real file end-to-end;
  assert the stored row's `metaCiphertext`/`contentCiphertext` contain neither the plaintext
  filename nor the plaintext bytes; owner download round-trips byte-for-byte; survivor claim
  lists the document and `survivor/document` returns a blob that decrypts to the original
  bytes. Extends the existing no-plaintext proof.

## Verification gates (per AGENTS.md)

`npm test` (unit) · `npx tsc --noEmit` (typecheck) · `npm run build` · live e2e round-trip.

## Out of scope (YAGNI)

- External/blob storage, chunked upload, multipart upload (not needed on Railway/Node).
- Document editing / rename (`PUT`) — immutable for now.
- Thumbnails / in-app preview, full-text search, virus scanning, versioning, folders/tags.
- Raising the cap above 5 MB.

## Open follow-ups (non-blocking)

- If the app moves to Vercel, switch upload to binary multipart or lower the cap (see risk
  note above).
- Optional later: rename support, drag-and-drop upload, multi-file select.
