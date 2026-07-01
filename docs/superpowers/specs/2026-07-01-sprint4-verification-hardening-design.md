# Sprint 4 · Slice 3 — Verification & Hardening (Design)

Date: 2026-07-01
Branch: `sprint4-survivor-mode` (builds on Slices 1 & 2)

## Summary

Server-side security and robustness hardening across the encrypted-record family
and the survivor-mode routes. All changes are guards over opaque `{ciphertext, iv}`
blobs — **no crypto, key-path, or zero-knowledge-invariant changes**. The server
still stores only ciphertext, IVs, and `bcrypt(authVerifier)`.

This slice is **code only**. The accumulated live-UI smoke checklists (Sprint 3
Slices A/B/C, survivor mode, documents) remain the maintainer's manual to-do and
are **not** automated here.

## Out of scope

- Google account-linking (deferred auth feature, not hardening).
- Automating the manual smoke checklists.
- Any change touching client-side crypto, the master-key derivation/escrow path,
  or the ZK invariant.

## Items

### 1. Request-body size ceiling (DoS guard) — keystone

**Problem.** `readJsonBody` (`src/lib/http.ts`) buffers the entire request body
before any size check. Survivor routes (`/api/survivor/salt`, `/api/survivor/claim`,
`/api/survivor`) parse the body **pre-authentication**, so an unauthenticated
attacker can POST arbitrarily large bodies and force the server to buffer them.

**Fix.** Change the signature to `readJsonBody(req, maxBytes)`:

1. If the `Content-Length` header is present and exceeds `maxBytes`, return **413**
   before reading the body.
2. Otherwise read via `req.text()` and re-check `raw.length > maxBytes` → **413**.
   This defends against an absent or lying `Content-Length`. (`text()` still
   buffers, but the string-length check is cheap and platform body limits plus the
   header pre-check bound the worst case; this is an honest best-effort guard, not a
   streaming cap.)
3. Parse JSON as today; malformed → 400.

**Per-route ceilings.**
- `MAX_JSON_BODY = 256 * 1024` (256 KB) — default for all encrypted-record routes,
  survivor routes, and auth routes. These carry small JSON blobs.
- `MAX_DOCUMENT_BODY` — for `/api/documents` POST only. Sized to fit the existing
  `MAX_CONTENT_CIPHERTEXT_CHARS` (8 MB) + `MAX_META_CIPHERTEXT_CHARS` (64 KB) + JSON
  overhead ≈ **9 MB**. Define as a named constant in `src/lib/document.ts`.

**Survivor opacity.** `/api/survivor/claim` already maps any `readJsonBody`
`NextResponse` to its generic `denied()` (401). Keep that — a 413 must not leak as
an account-existence / enumeration signal on the claim path. Salt and arm routes may
surface 413 directly (not tied to account existence).

**Return code.** 413 Payload Too Large, JSON body `{ error: "Request too large." }`.

### 2. `@@index([userId])` on all list-scanned record models

Add `@@index([userId])` to `VaultItem`, `FinancialAccount`, `Bill`, `Loan`,
`Beneficiary`, and `Document` in `prisma/schema.prisma`. The models with
`userId String @unique` (`Obituary`, `ReadinessState`, `SurvivorAccess`) already
have an implicit index and are untouched.

One migration under `prisma/migrations/`, applied to **both** the dev DB (`.env`)
and the test DB (`.env.test`), committed as a file so the pipeline applies it.

### 3. `Cache-Control: no-store` on ciphertext responses

Add a small shared helper (e.g. `noStore(response)` or a header constant) and apply
it to every GET that returns ciphertext:

- Generic encrypted-record list GET (`createEncryptedRecordRoute`).
- `/api/documents` GET (list-meta) and `/api/documents/[id]` GET (content).
- `/api/survivor/document` and `/api/survivor/claim`.

Low risk: the payloads are already opaque, but `no-store` prevents intermediary or
browser caching of ciphertext blobs.

### 4. Per-user document quota — 50 docs / 100 MB

Per-file is already capped at 5 MB (`MAX_FILE_BYTES`). Add per-user ceilings in
`/api/documents` POST, enforced **before** create:

- `MAX_DOCUMENTS_PER_USER = 50`
- `MAX_TOTAL_CONTENT_BYTES = 100 * 1024 * 1024` (measured on `contentCiphertext`
  character length, i.e. base64 chars)

Both constants live in `src/lib/document.ts`. Enforce with a single indexed raw
aggregate (rides on the new `userId` index, no new column or backfill):

```sql
SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH("contentCiphertext")), 0) AS bytes
FROM "Document" WHERE "userId" = $1
```

- `n >= MAX_DOCUMENTS_PER_USER` → **409** `{ error: "Document limit reached." }`
- `bytes + newContentCiphertext.length > MAX_TOTAL_CONTENT_BYTES` → **409**
  `{ error: "Storage limit reached." }`

### 5. Survivor-claim hardening — split the route

**Problem.** `/api/survivor/claim` loads the **entire vault** (all record types +
documents + obituary) in one `findUnique` include *before* the bcrypt verify. Any
request with a valid email triggers a full-vault DB fetch, and the early
`return denied()` for non-armed accounts vs. the bcrypt path for armed accounts is
a **timing oracle** for "is this account armed."

**Fix.**
1. Query 1: fetch only `user { id, survivorAccess }` by email.
2. **Always** run a bcrypt compare — against the real
   `survivorAuthVerifierHash` when armed, against a constant decoy hash otherwise
   (mirror the existing salt-decoy / login timing-parity pattern; reuse the existing
   decoy hash if one is defined in `src/lib/auth.ts`).
3. Only when the compare passes **and** the account is armed, run Query 2 to load the
   full vault and return it.
4. Every failure path returns the generic `denied()` (401).

**Test gaps to close** (flagged in the Slice-1 review):
- Claim with an empty `survivorAuthVerifier` → `denied()`.
- Salt route with an empty email → decoy salt (no enumeration).

### 6. Survivor / UI nits

- Add `.catch` to the copy-recovery-code clipboard call (no unhandled rejection).
- Gate the survivor-status CTA render on load-complete to avoid a CTA flash.
- Replace `key={i}` with stable keys on the read-only lists in `/recover` and
  `/survivor`.

## Testing & gates

- **Unit** (`*.test.ts` next to source):
  - Body-size ceiling: 413 when `Content-Length` over, 413 when actual text over,
    pass when under; malformed still 400.
  - Document quota: count cap 409, byte cap 409, under-limit passes.
  - Survivor claim: verify runs even when unarmed (parity); passing verify on armed
    account returns vault; empty-verifier → denied; salt empty-email → decoy.
- **Migration** applied to dev + test DBs, committed under `prisma/migrations/`.
- **Gates:** `npm test`, `npx tsc --noEmit`, `npm run build` — all green.
- **Live e2e** (`npx vitest run --config vitest.e2e.config.ts`, not in `npm test`):
  extend to assert 413-on-oversize body, the `no-store` header on a ciphertext GET,
  and a quota 409 — while keeping the existing no-plaintext round-trip proofs.

## ZK invariant note

Every change in this slice is a server-side guard over already-opaque data or a
DB-index/quota/caching concern. Nothing reads plaintext, derives or transports a
key, or alters the escrow/master-key path. The zero-knowledge invariant is
preserved by construction.
