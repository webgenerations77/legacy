# Survivor Mode — Recovery-Code Escrow (Sprint 4, Slice 1)

**Status:** Approved design — ready for implementation plan
**Date:** 2026-06-30
**Sprint 4 context:** Slice 1 of 3. Slice 2 = encrypted document/file storage; Slice 3 = verification & hardening. This slice defines the key-recovery architecture the later slices must honor.

## Problem

Legacy is a zero-knowledge estate-planning vault. The master key is derived in the
browser from the owner's passphrase (`PBKDF2-600k`) and never reaches the server.
That is exactly what makes the vault useless to a survivor: when the owner dies or is
incapacitated, an executor/beneficiary has the encrypted data but no way to decrypt it.

Survivor mode must let a designated survivor decrypt the vault **without the owner's
passphrase**, while preserving the zero-knowledge invariant: the server must never be
able to decrypt on its own.

## Key architectural insight

There is **no key-wrapping/envelope layer today** — every record is AES-GCM-encrypted
*directly* with the master key (`masterKey = PBKDF2(passphrase, kdfSalt)`). Rather than
introduce a new vault data-key and re-encrypt all existing records, we **escrow the
master key itself**: store `AES-GCM(survivorKey, masterKey)` server-side, where
`survivorKey` is derived from a high-entropy recovery code that only the survivor holds.
The survivor recovers the *real* master key and decrypts every existing record untouched.
No migration of existing ciphertext is required.

This reuses `src/lib/crypto.ts` in full — no new crypto primitives.

## Access model (decided)

**Recovery code / "sealed envelope".** The owner generates a one-time recovery code,
stores it safely out-of-band (lawyer, sealed letter, safe), and the server stores the
master key wrapped by it. Anyone holding the code can unlock **read-only** access
immediately. The code's ~100-bit entropy is the protection.

Rejected alternatives: designated-survivor + dead-man's-switch (needs cron + email
infra that does not exist), and public-key emergency access (over-engineered for v1).

## Crypto flows (all client-side; server sees only opaque blobs)

### Arming (owner, vault unlocked so `masterKey` is in memory)

1. `recoveryCode = generateRecoveryCode()` — 20 Crockford-base32 chars, 4 groups of 5,
   dash-separated (e.g. `K7Q2M-9XTR4-…`), ≈100 bits from `crypto.getRandomValues`.
2. `survivorSalt = generateSalt()`
3. `survivorKey = deriveMasterKey(recoveryCode, survivorSalt)` (PBKDF2-600k; recovery
   code treated as a passphrase).
4. `escrow = encryptItem(survivorKey, base64(masterKey))` → `{ ciphertext, iv }` —
   wraps the **actual master key bytes** (base64-encoded as the plaintext string).
5. `survivorAuthVerifier = deriveAuthVerifier(survivorKey, recoveryCode)` — mirrors the
   existing login verifier exactly.
6. `POST /api/survivor { survivorSalt, survivorAuthVerifier, escrowCiphertext, escrowIv }`.
   Server `bcrypt`s the verifier and upserts the row.

**The recovery code is displayed to the owner exactly once and is never stored anywhere.**

### Unlocking (survivor, public page, no account)

1. Survivor enters **owner email + recovery code**.
2. `POST /api/survivor/salt { email }` → returns the real `survivorSalt` if armed, else a
   deterministic **decoy salt** (see Anti-enumeration). Response shape is identical either way.
3. `survivorKey = deriveMasterKey(recoveryCode, survivorSalt)`;
   `survivorAuthVerifier = deriveAuthVerifier(survivorKey, recoveryCode)`.
4. `POST /api/survivor/claim { email, survivorAuthVerifier }` → server `bcrypt`-compares
   against `survivorAuthVerifierHash`. On match, returns `{ escrowCiphertext, escrowIv }`
   **plus all encrypted records** (every encrypted-record type + the obituary).
5. Client: `masterKeyB64 = decryptItem(survivorKey, escrowCiphertext, escrowIv)`, recover
   `masterKey` bytes, then decrypt every record with the existing `parse` libs and render
   read-only. **Nothing is persisted client-side; closing the tab ends access.** Refresh
   re-runs the claim. There is no server-side survivor session.

### Zero-knowledge invariant

The server only ever persists `survivorSalt`, `bcrypt(survivorAuthVerifier)`, and opaque
`escrowCiphertext`/`escrowIv`. The recovery code and master key never leave the browser.
The `claim` response returns only ciphertext. Invariant fully preserved.

## Data model

One new Prisma model + one migration applied to **both** dev (`.env`) and test
(`.env.test`) DBs, committed under `prisma/migrations/`.

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

Add `survivorAccess SurvivorAccess?` to `User`. Single-row-per-user with a verifier, so
this is a **custom route**, not `createEncryptedRecordRoute`.

## Routes

| Route | Auth | Behavior |
|---|---|---|
| `POST /api/survivor` | owner session (`requireUserId`) | Arm/regenerate. Upsert by `userId`; regenerating overwrites the row, silently killing the old code. |
| `GET /api/survivor` | owner session | Status: `{ armed: boolean, updatedAt? }`. |
| `DELETE /api/survivor` | owner session | Revoke: delete the row. |
| `POST /api/survivor/salt` | public | `{ salt }` — real if armed, deterministic decoy otherwise. |
| `POST /api/survivor/claim` | public (verifier *is* the auth) | `bcrypt`-verify; on success return escrow + all encrypted records. Wrong code → generic `401` (no email-vs-code distinction). |

The `claim` route gathers records from every encrypted-record model
(`vaultItems`, `financialAccounts`, `bills`, `loans`, `beneficiaries`) plus `obituary`,
each as its existing `{ ciphertext, iv }` (obituary returns its stored `draft`/`intake`
as today). Records are returned grouped by type so the survivor view can label them.

### Anti-enumeration (decoy salt)

A new env var `SURVIVOR_SALT_SECRET` is introduced. For an email with no armed survivor
access, the salt endpoint returns a **stable, indistinguishable decoy**:
`decoySalt = base64(HMAC-SHA256(SURVIVOR_SALT_SECRET, normalizedEmail))` truncated to the
salt byte length. This keeps responses uniform (same shape, deterministic per email) so
the endpoint cannot be used to discover whether an email has survivor access armed. The
subsequent `claim` simply fails `bcrypt` for decoy-derived verifiers. Added to `.env`,
`.env.test`, and documented for prod.

## UX

### Owner — `src/app/survivor/page.tsx` ("Survivor Access", linked from `AppNav`)

- **Unarmed:** explain the feature + a "Set up survivor access" action. Requires an
  unlocked vault (master key in memory); if locked, route through the existing unlock gate.
  On arm, show the recovery code **once** in a copy-and-print panel with a stern
  "save this now — we can never show it again" warning.
- **Armed:** show status ("armed since <date>"), **Regenerate code** (warns the old code
  stops working), and **Remove survivor access** (revoke).

### Survivor — `src/app/unlock/page.tsx` (public, outside owner auth)

- Form: owner email + recovery code → claim → read-only dashboard grouping all record
  types + obituary.
- **Print / Download** action: print-friendly CSS view + a client-side text/JSON file
  download of the decrypted contents for an offline hard copy.
- Entirely client-side after the claim response; nothing is stored; closing the tab ends access.

## New domain lib

`src/lib/survivor.ts` — pure, unit-tested:
- `generateRecoveryCode(): string`
- `normalizeRecoveryCode(input: string): string` (strip dashes/whitespace, uppercase)
- `formatRecoveryCode(raw: string): string` (re-group for display)
- `decoySalt(secret: string, email: string): string` (pure HMAC helper)

The actual WebCrypto calls (arm/claim derivation) live in a client module that composes
`crypto.ts` helpers; they are exercised by the live e2e test rather than unit-mocked.

## Error handling

- Arming with a locked vault → redirect through the unlock gate (no master key available).
- `claim` wrong code → generic `401 { error: "Could not unlock." }`; never distinguishes
  bad email from bad code.
- `salt` always returns a salt (real or decoy); never 404s, to avoid enumeration.
- Malformed bodies → `400` via the existing `readJsonBody` helper.

## Testing

- **Unit (`src/lib/survivor.test.ts`):** recovery-code format/normalize round-trip;
  `decoySalt` determinism + length; arm→claim derivation round-trip (a `survivorKey`
  derived from the same code+salt unwraps the escrow back to the original key bytes).
- **Route tests:** arm requires auth (`401` without session); GET status before/after arm;
  claim succeeds with right verifier and `401`s with wrong; revoke deletes; salt returns a
  decoy (not 404) for unknown email.
- **Live e2e (`vitest.e2e.config.ts`):** full survivor round-trip — register, populate
  records, arm, claim with the code, assert every record decrypts; and assert the stored
  `SurvivorAccess` row and the encrypted-record blobs contain **no plaintext**
  (zero-knowledge proof). Note: `Obituary` is plaintext by design and is exempt from the
  no-plaintext assertion.

## Out of scope (this slice)

- Dead-man's-switch / inactivity release / email notification (no email infra; rejected model).
- Passphrase-change interaction (no such feature exists yet). **Constraint for the future:**
  because the master key is escrowed directly, changing the passphrase will re-derive the
  master key and **invalidate the recovery code** — a passphrase-change feature must
  re-arm survivor access (or move to an envelope/DEK scheme).
- Per-record survivor visibility flags.
- Rate-limiting/lockout on `claim` beyond `bcrypt` cost + ~100-bit code entropy
  (tracked for Slice 3 hardening).
- Survivor editing/delete and AI-assistant access (read-only only).

## Verification gates

`npm test` (unit) · `npx tsc --noEmit` (types) · `npm run build` · live e2e round-trip.
Migration committed and applied to dev + test DBs.
