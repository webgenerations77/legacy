# Change Vault Passphrase — design

**Date:** 2026-07-01
**Status:** Approved (design phase)

Let an authenticated, unlocked user rotate their vault passphrase. Today this is
impossible: the master key is derived *directly* from the passphrase and used as the
AES-GCM data key, so changing the passphrase would change the key and orphan every
ciphertext (and the survivor escrow). This introduces a thin **wrapped-data-key** layer so
the data key is permanent and only its *wrapping* changes — making rotation an atomic,
single-row update with no re-encryption and no impact on survivor access.

## Scope (locked from brainstorming)

**In scope:** authenticated change — a logged-in, vault-unlocked user who knows their
current passphrase sets a new one.

**Out of scope (future slices):**
- **Reset via recovery code** (forgot the passphrase → use the survivor recovery code to
  recover the data key and set a new passphrase).
- **Rotating the recovery code** as part of a passphrase change.
- Any bulk re-encryption path.

## Key model

Today: `masterKey = PBKDF2(passphrase, kdfSalt, 600k)`, used directly as the AES-GCM key for
all records/documents; `authVerifier = PBKDF2(masterKey, passphrase)`; the survivor escrow
wraps `masterKey`.

New: reframe that key as a permanent **data key (DK)** and wrap it.

- **KEK** (key-encrypting key) `= PBKDF2(passphrase, kdfSalt, 600k)` — this is *exactly*
  today's derivation, so `deriveMasterKey` is reused unchanged; it now yields the KEK.
- **DK** — the AES-GCM key for all records/documents. **Permanent per user; never changes.**
- **`wrappedKey = AES-GCM(KEK, DK)`** — stored on the user row as
  `{ wrappedKeyCiphertext, wrappedKeyIv }`.
- `authVerifier = PBKDF2(KEK, passphrase)` — same formula as today (KEK plays the master
  key's former role).

The wrapping is the exact pattern `survivor-crypto.ts` already uses
(`encryptItem(key, bytesToBase64(dataKey))` / `base64ToBytes(decryptItem(...))`), so this
adds thin helpers, not new primitives.

### Legacy accounts and the absence of a bulk migration

An existing account has `wrappedKey = null`; its DK *is* today's
`M = PBKDF2(passphrase, kdfSalt)`. There is **no proactive migration and no
re-encryption**:

- **Unlock branches on `wrappedKey` presence.** Null → the derived key *is* the DK (legacy
  path, identical to today). Present → unwrap DK with the KEK.
- **Changing the passphrase is what upgrades an account to wrapped-mode.** The client
  (unlocked, holding DK) derives a fresh `KEK'` from the new passphrase + a new salt,
  computes `wrappedKey = AES-GCM(KEK', DK)`, and stores it. **DK is unchanged**, therefore:
  - no record or document is ever re-encrypted;
  - the **survivor escrow (which wraps DK) stays valid** — no re-arm, no recovery code
    needed.

New registrations stay legacy-mode and upgrade on their first passphrase change. **Register
is untouched.**

## Data model

Add two nullable columns to `User`:

- `wrappedKeyCiphertext String?`
- `wrappedKeyIv String?`

One additive migration, applied to **both** dev (`.env`) and test (`.env.test`) DBs and
committed under `prisma/migrations/`. No record/document/survivor table changes.

## Crypto helpers (`src/lib/crypto.ts`)

Thin wrappers over existing primitives (mirroring survivor-crypto):

- `wrapDataKey(kek: CryptoBytes, dataKey: CryptoBytes): Promise<{ ciphertext, iv }>`
  = `encryptItem(kek, bytesToBase64(dataKey))`.
- `unwrapDataKey(kek: CryptoBytes, ciphertext: string, iv: string): Promise<CryptoBytes>`
  = `base64ToBytes(await decryptItem(kek, ciphertext, iv))`.

KEK derivation reuses `deriveMasterKey`. `deriveAuthVerifier` is unchanged.

## Routes

### `GET /api/auth/vault/wrapped-key` (session-scoped)

Returns `{ wrappedKeyCiphertext: string, wrappedKeyIv: string }` when set, else
`{ wrappedKeyCiphertext: null }`. **401** when unauthenticated.

**Security — post-auth only.** `wrappedKey` is never exposed before login. Returning it from
the unauthenticated `getSalt` would hand an attacker (knowing only an email) offline
passphrase-cracking material (derive candidate KEK, test-decrypt the wrapped key). Fetched
post-login, it is no worse than the record ciphertext a session already exposes.

### `POST /api/auth/vault/change-passphrase` (session-scoped, re-auth)

Body: `{ currentAuthVerifier, kdfSalt, wrappedKeyCiphertext, wrappedKeyIv, authVerifier }`
(parsed via `readJsonBody`, so it inherits the body-size ceiling).

1. `requireUserId()` → 401 if no session.
2. Load the user; bcrypt-verify `currentAuthVerifier` against `authVerifierHash` (generic
   401 `"That passphrase didn't match."` on mismatch or missing hash).
3. On success, **one atomic update** of
   `{ kdfSalt, wrappedKeyCiphertext, wrappedKeyIv, authVerifierHash: bcrypt(authVerifier) }`.
4. Return `{ ok: true }`.

Requiring the current passphrase even in an unlocked session matches the security-first
posture of the account-linking feature: a hijacked session alone cannot silently rotate the
passphrase.

## Client

### `src/lib/api-client.ts`

- `wrappedKey(): Promise<{ wrappedKeyCiphertext: string | null; wrappedKeyIv?: string }>`
  (null on 401 handled by the caller as "stay locked").
- `changePassphrase(body): Promise<{ ok: true }>`.

### Unlock — one shared helper

The three handlers that call `setMasterKey` — `onEmailSubmit` (email login), `onEnterSubmit`
(Google user entering the vault passphrase), and `onLinkSubmit` (collision-link) — route the
derived key through:

```
resolveDataKey(kek: CryptoBytes): Promise<CryptoBytes>
  const wk = await api.wrappedKey()
  return wk.wrappedKeyCiphertext
    ? unwrapDataKey(kek, wk.wrappedKeyCiphertext, wk.wrappedKeyIv!)  // DK
    : kek                                                            // legacy: DK == derived key
```

Each becomes `setMasterKey(await resolveDataKey(derivedKey))`. A session always exists by the
time these run (login / vaultUnlock / googleLink each establish or already hold one), so the
authenticated fetch always succeeds. `onCreateSubmit` (Google first-time vault setup) stays
legacy-mode — it creates no `wrappedKey`; routing it through `resolveDataKey` is harmless
(returns the derived key) and keeps the code uniform.

**Fail closed:** if `resolveDataKey`'s fetch fails, surface the generic error and leave the
user locked — never `setMasterKey` with a possibly-wrong key.

### Change-passphrase UI — on `/account`

`/account` (from the account-linking feature) is the settings home. Add a **"Change vault
passphrase"** section with *current*, *new*, *confirm new* fields.

- The section needs DK in memory (`KeyProvider`). If the vault is locked (no key), show a
  short "unlock your vault to change your passphrase" prompt linking to `/unlock`, not the
  form.
- On submit: fetch the current `kdfSalt` (via the session-scoped `vault/status`), derive
  `currentKEK` + `currentAuthVerifier` (re-auth); generate a fresh `newSalt`, derive
  `newKEK = PBKDF2(newPass, newSalt)`, `wrappedKey = AES-GCM(newKEK, DK)` (DK from
  `KeyProvider`), `newAuthVerifier = PBKDF2(newKEK, newPass)`; `POST change-passphrase`.
- On success DK is unchanged, so the in-memory key stays valid and the session continues —
  show a success notice; no forced re-login.

## Flows

**Change (happy path):** `/account`, unlocked → enter current + new + confirm → client
re-auths and re-wraps DK under the new KEK → `POST change-passphrase` → atomic row update →
success notice; still unlocked, DK unchanged.

**Next unlock after a change:** `getSalt` → new salt; derive KEK from new passphrase;
`authVerifier = PBKDF2(KEK, newPass)` → login; `wrappedKey` now present → unwrap DK →
`setMasterKey(DK)`. Old passphrase no longer logs in.

**Legacy account, never changed:** unchanged from today — `wrappedKey` null, derived key is
the DK.

**Survivor:** unaffected in every case — DK is stable, so the escrow keeps recovering the
same DK.

## Error handling

- Wrong current passphrase → generic 401 `"That passphrase didn't match."`; no update runs.
- New passphrase too short / confirm mismatch → inline client error, no request sent.
- `change-passphrase` malformed/oversized body → 400/413 via `readJsonBody`; unauth → 401.
- `wrapped-key` GET unauth → 401.
- `resolveDataKey` fetch failure → generic error, stay locked (fail closed).

## Testing

**Unit — crypto helpers (`src/lib/crypto.test.ts`):** `wrapDataKey`/`unwrapDataKey` round-trip
to identical bytes; unwrap with the wrong KEK rejects.

**Unit — routes:**
- `change-passphrase`: correct current → atomic update of the four fields (assert
  `update` called with all four); wrong/absent current → 401, no update; malformed body →
  400; unauth → 401.
- `wrapped-key`: returns the pair when set; `{ wrappedKeyCiphertext: null }` when unset;
  401 unauth.

**Unit — client:** `resolveDataKey` returns the unwrapped DK when `wrappedKey` present, and
the passed key when absent.

**Live e2e** (extends `e2e.spec.ts`; needs dev server + dev DB): register → unlock → store
an encrypted record → change passphrase → the in-memory key still decrypts the record (DK
unchanged) → re-login with the **new** passphrase and decrypt the stored record → the **old**
passphrase now fails login (401) → a previously-armed **survivor recovery code still
recovers** the vault. Assert the DB row's `authVerifierHash` changed and
`wrappedKeyCiphertext` is now populated, and that no passphrase / DK / plaintext was ever
sent to the server.

## Out of scope (future slices)

- Reset-via-recovery-code (forgot passphrase).
- Recovery-code rotation.
- Proactive/bulk migration of legacy accounts (they upgrade lazily on first change).
- Minting a fresh random DK for new registrations (they stay legacy-mode until first change;
  a future cleanup could make register wrap from birth).
