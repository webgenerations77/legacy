# Legacy — Sprint 1 Walking Skeleton: Design Spec

**Date:** 2026-06-28
**Scope:** A thin, end-to-end vertical slice proving the encryption-first foundation of the Legacy platform: register → unlock → create an encrypted vault item → reload → re-unlock → decrypt and display.
**Status:** Approved design, pending implementation plan.

---

## 1. Goal & Non-Goals

### Goal
Prove the **zero-knowledge encrypt → store ciphertext → decrypt** loop works on a real, deployable stack. This is the single highest-value thing to validate before building breadth, because the encryption/key model is the foundation every other Legacy subsystem depends on.

Success = a user can register, add a vault item, fully reload the browser, re-enter their passphrase, and see the item decrypted — while the server only ever stored ciphertext and an auth-verifier hash.

### Non-Goals (deferred to later sprints)
- Financial accounts, bills, documents vault, digital accounts
- AI assistant, obituary generator, legacy readiness scoring
- Survivor activation, family access, notifications
- Profile beyond email
- Passphrase recovery / recovery keys (the "forget passphrase = data is gone" property is **accepted** for now)
- Passkeys, MFA, OAuth
- Rate limiting, CSRF tokens, account-enumeration hardening (see §6)

---

## 2. Stack

- **One Next.js app** (App Router, TypeScript strict) — UI + server logic (route handlers) in a single codebase. A dedicated backend can be split out in a later sprint without changing the encryption design.
- **Prisma ORM → PostgreSQL on Railway** — production parity from day one; Railway is also the deploy target. `DATABASE_URL` connection string lives in `.env` (gitignored).
- **Browser-native WebCrypto** — PBKDF2 (key derivation) + AES-GCM (encryption). No third-party crypto libraries.
- **Sessions** — signed, httpOnly, SameSite cookie carrying a random session token stored in the DB.

---

## 3. Architecture: the zero-knowledge flow

One passphrase produces two different things, entirely in the browser:

```
            passphrase + per-user salt
                       │
              PBKDF2 (in browser)
                       │
        ┌──────────────┴───────────────┐
        ▼                               ▼
   MASTER KEY                     AUTH VERIFIER
 (never leaves device)        (sent to server to log in)
 encrypts/decrypts vault      server stores only a HASH of it
```

The server only ever sees the auth verifier's **hash** and **ciphertext**. It can authenticate the user but can never derive the master key or read vault contents. That is the zero-knowledge guarantee.

### Exact derivation (Bitwarden-style double-derivation)

Both values come from the same passphrase but the auth verifier is derived *from the master key through a one-way step*, so possession of the verifier (or its stored hash) cannot reproduce the master key:

```
masterKey    = PBKDF2(passphrase, salt,       iterations=600_000, SHA-256, 256-bit)
authVerifier = PBKDF2(masterKey,  passphrase, iterations=1,       SHA-256, 256-bit)
```

- `masterKey` is used directly as the AES-GCM 256-bit key for vault items. It never leaves the browser.
- `authVerifier` is what the browser sends on register/login. The server stores only `bcrypt(authVerifier)`.
- Because `authVerifier` is a one-way function of `masterKey`, the server (and anyone who breaches it) cannot run the derivation backward to obtain `masterKey`.
- `salt` is a 128-bit random value per user, stored in plaintext (it is not secret; it only prevents precomputation).

### Two distinct concepts, kept separate
- **Server session** (httpOnly cookie) = "who you are." Authorizes API calls.
- **Master key** (in-memory only, React context) = "decrypts your data." Never sent anywhere; lost on page refresh by design.

### Flows

**Register**
1. Browser generates a random `salt`.
2. Derives `masterKey` and `authVerifier` from `passphrase + salt` via PBKDF2.
3. Sends `{ email, salt, authVerifier }`.
4. Server stores `email`, `salt`, `bcrypt(authVerifier)`. Plaintext and master key are never transmitted.

**Unlock / Login**
1. Browser requests the `salt` for the given email.
2. Re-derives `masterKey` + `authVerifier`.
3. Sends `authVerifier`; server compares against the stored hash.
4. On match, server issues a session cookie. Browser keeps `masterKey` in memory (React context) only.

**Vault read/write**
- **Write:** browser encrypts the full item (including its label) with AES-GCM using `masterKey` and a fresh random IV; sends `{ ciphertext, iv }`.
- **Read:** server returns the user's `{ id, ciphertext, iv }` blobs; browser decrypts in memory.

---

## 4. Data Model (Prisma)

```prisma
model User {
  id               String      @id @default(cuid())
  email            String      @unique
  kdfSalt          String      // base64; per-user, public (needed to derive key)
  authVerifierHash String      // bcrypt hash of the auth verifier
  createdAt        DateTime    @default(now())
  sessions         Session[]
  vaultItems       VaultItem[]
}

model Session {
  id        String   @id @default(cuid()) // random token; also the cookie value
  userId    String
  expiresAt DateTime
  createdAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model VaultItem {
  id         String   @id @default(cuid())
  userId     String
  ciphertext String   // base64 AES-GCM output — opaque to server
  iv         String   // base64 per-item nonce
  createdAt  DateTime @default(now())
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

**Deliberate property:** `VaultItem` stores no plaintext metadata (no title, type, or notes). The entire item — including its label — is encrypted into `ciphertext`. The server stores nothing readable. (Encrypted-but-searchable metadata is a later concern.)

---

## 5. API (Next.js route handlers)

| Method + path        | Purpose                                              | Auth   |
|----------------------|------------------------------------------------------|--------|
| `POST /api/auth/register` | Create user from `{ email, salt, authVerifier }`     | none   |
| `POST /api/auth/salt`     | Return `kdfSalt` for an email (needed before deriving) | none   |
| `POST /api/auth/login`    | Verify `authVerifier`, set session cookie            | none   |
| `POST /api/auth/logout`   | Clear session                                        | cookie |
| `GET /api/vault`          | List current user's `{ id, ciphertext, iv }`         | cookie |
| `POST /api/vault`         | Store one `{ ciphertext, iv }`                        | cookie |

### Pages
- `/register` — email + passphrase; derives keys client-side, registers.
- `/unlock` — login + re-derive master key into memory.
- `/vault` — list decrypted items + add-item form. Gated by a client-side `KeyProvider`; if no in-memory master key, redirect to `/unlock`.

---

## 6. Error Handling & Security Posture

### Error handling (calm tone, per the design system)
- Wrong email **or** passphrase → single generic message: *"That email or passphrase didn't match."* (never reveals which).
- Decryption failure (AES-GCM auth-tag mismatch) → *"We couldn't unlock this item."*
- Expired/missing session → redirect to `/unlock`.
- Lost master key on refresh → `/vault` detects no in-memory key → routes to `/unlock`.
- Duplicate email on register → *"An account with this email already exists."*

### Security posture (skeleton level)
- `authVerifierHash` stored with **bcrypt**.
- Sessions: random tokens in **httpOnly + SameSite** cookies.
- **PBKDF2** at 600,000 iterations (SHA-256), per §3, with a per-user 128-bit random salt.
- **AES-GCM** with a fresh random 96-bit IV per item.

### Known / deferred (documented, not built now)
- KDF upgrade to **Argon2id**.
- **Account-enumeration hardening** — `POST /api/auth/salt` reveals whether an email is registered; true zero-knowledge auth (SRP/OPAQUE) avoids this but is too heavy for the skeleton. **Accepted trade-off.**
- Passphrase recovery / recovery keys.
- Rate limiting, CSRF tokens, passkeys, MFA.

---

## 7. Assets & Visual Design

Light application of `03_UI_UX_Design_System.md`: calm, Apple-like simplicity; soft neutrals / warm grays with subtle-blue accents; supportive, non-alarming tone. Minimal — enough that the skeleton feels like Legacy, not a wireframe.

Visual assets (backgrounds, icons, brand marks) are being produced separately via Claude Design and will drop into this structure without rework:

```
public/
  brand/          # logo, wordmark
  backgrounds/    # background images
  icons/          # standalone icon files (PNG/SVG)
components/
  icons/          # optional: inline SVG icon components (inherit currentColor / theme)
```

- Raster images → `/public`, referenced via `next/image` for optimization.
- SVG icons that need recoloring/animation may live as React components in `components/icons/`.
- The skeleton ships with minimal styling; real assets swap in as they arrive.

---

## 8. Testing

- **TDD for the crypto core (`lib/crypto`)** — pure functions, the riskiest code:
  - round-trip: derive → encrypt → decrypt returns the original plaintext
  - wrong passphrase fails to decrypt
  - tampered ciphertext throws (AES-GCM auth tag)
  - WebCrypto runs in Node 20+, so these run fast without a browser.
- **API integration tests** against a throwaway test database: register → login → store item → list returns the same ciphertext; unauthorized requests rejected.
- **Manual walking-skeleton check** (the real proof, run via the `/run` skill): register → add a vault item → reload → re-enter passphrase → item decrypts and displays.

---

## 9. Build Prerequisites

- A Railway PostgreSQL instance (provision if it doesn't exist yet) and its `DATABASE_URL`.
- `.env` (gitignored) holds `DATABASE_URL` and a session-signing secret; `.env.example` holds placeholders only.

---

## 10. Module Boundaries

| Unit | Does | Depends on |
|------|------|------------|
| `lib/crypto` | derive keys, encrypt, decrypt (pure, browser + Node) | WebCrypto only |
| `lib/auth` (server) | hash/verify auth verifier, create/validate sessions | Prisma, bcrypt |
| `app/api/*` route handlers | HTTP surface for auth + vault | `lib/auth`, Prisma |
| `KeyProvider` (client) | hold master key in memory, gate `/vault` | `lib/crypto` |
| `app/(pages)` | register / unlock / vault UI | `KeyProvider`, fetch API |
| Prisma schema | persistence of opaque blobs + auth data | Postgres |
```

Each unit has one purpose and a well-defined interface; the crypto core is testable in isolation, and the server never holds anything that can decrypt vault data.
