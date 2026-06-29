# Google Sign-In — design

**Date:** 2026-06-29
**Status:** Approved (design phase)

Add "Continue with Google" as a second sign-up / sign-in path for Legacy, **alongside**
the existing email + passphrase auth. Google establishes the *session* (identity);
a separate **vault passphrase** still derives the encryption master key in the
browser, exactly as today. The zero-knowledge invariant is unchanged: the server
never sees the passphrase or the master key, and stores only ciphertext, IVs, and
`bcrypt(authVerifier)`.

## Decisions locked (from brainstorming)

- **Key model:** Google + separate vault passphrase. ZK fully intact.
- **Scope:** added alongside email/passphrase; existing email accounts keep working.
- **Account linking** (attaching Google to a pre-existing email account) is **deferred**
  to a later slice.
- **OAuth mechanism:** manual OIDC (authorization-code + PKCE) wired into the app's
  existing custom `Session` model. No next-auth/Auth.js (it would bring a parallel
  session/account model that fights the current one).

## Why the crypto does not change

Today the master key is `PBKDF2(passphrase, kdfSalt, 600k)` used *directly* as the
AES-GCM key; there is no separate wrapped data-encryption key. Because Google only
provides *identity*, and the vault passphrase still derives the key client-side, no
new key-wrapping is needed. This slice is an additive auth layer plus a "set / enter
your vault passphrase" step layered on top of a Google-established session.

## Data model — one additive migration (both DBs)

On `User`:

- `googleId String? @unique` — the Google `sub` claim (stable per-account id).
- `kdfSalt String?` and `authVerifierHash String?` become **nullable**. They are empty
  for the window between "Google account created" and "vault passphrase set". Existing
  email users are unaffected (theirs remain populated). Nullable is chosen over a
  separate `vaultInitialized` flag because it is simpler and self-describing
  (`kdfSalt == null` ⇔ vault not yet initialized).

No change to any encrypted-record table. `Session` is unchanged — Google logins reuse
the existing `createSession`.

## Components

### `src/lib/oauth-google.ts`

Wraps `arctic` (Google OAuth2 authorization-code + PKCE) and `jose` (verify the ID
token against Google's JWKS). The ID-token verification sits behind an **injectable
seam** so callback logic is testable without contacting Google. Exposes roughly:

- `createGoogleAuthUrl(state, codeVerifier): URL`
- `exchangeGoogleCode(code, codeVerifier): Promise<{ idToken: string }>`
- `verifyGoogleIdToken(idToken): Promise<{ googleId: string; email: string; emailVerified: boolean }>`
  (the verifier is the injectable seam)

### Routes (Next 16 App Router, `Request`/`NextResponse`)

- `GET /api/auth/google/start` — generate `state` + PKCE `code_verifier`, store both in
  short-lived httpOnly cookies, 302 to Google's authorization URL.
- `GET /api/auth/google/callback` — validate `state` against the cookie; exchange the
  code; verify the ID token; **require `email_verified === true`**. Resolve the user:
  1. by `googleId` → existing Google user;
  2. else by `email`:
     - if that email is an existing **passphrase** account (`googleId == null`) →
       redirect to the unlock page with an "account exists — sign in with your
       passphrase (Google linking coming later)" message. (linking deferred)
     - else create `User(googleId, email)` with null `kdfSalt`/`authVerifierHash`.
  Then `createSession(userId)` + set `SESSION_COOKIE`, clear the state/PKCE cookies,
  redirect to `/unlock`.
- `GET /api/auth/vault/status` (session-scoped) — `{ initialized: boolean, salt?: string }`
  so the unlock page knows whether to **set** or **enter** the passphrase and has the
  salt to derive the key.
- `POST /api/auth/vault/init` (session-scoped) — `{ salt, authVerifier }`; stores them
  **only if currently null**. If already initialized → `409` (never overwrite).
- `POST /api/auth/vault/unlock` (session-scoped) — `{ authVerifier }`; bcrypt-verify
  against the stored hash; `200`/`401`. Gives Google users the same wrong-passphrase
  feedback email users get.

### UI

- "Continue with Google" button on `src/app/register/` and `src/app/unlock/` pages
  (links to `/api/auth/google/start`), styled to the existing calm brand kit.
- `/unlock` gains set-vs-enter branching driven by `vault/status`:
  - `initialized:false` → "Create your vault passphrase" → derive salt + master key +
    authVerifier client-side → `vault/init` → `setMasterKey` → `/vault`.
  - `initialized:true` → "Enter your vault passphrase" → derive → `vault/unlock`
    verifies → `setMasterKey` → `/vault`.

### Client

- `src/lib/api-client.ts` gains `vaultStatus()`, `vaultInit(salt, authVerifier)`,
  `vaultUnlock(authVerifier)`. The Google start/callback are plain browser navigations
  (not fetch). `KeyProvider` already holds the in-memory master key — unchanged.

## Flows

**New Google user:** Continue with Google → consent → callback creates user + session →
`/unlock` sees `initialized:false` → set passphrase → `vault/init` → `setMasterKey` →
`/vault`.

**Returning Google user:** Continue with Google → callback → session → `/unlock` sees
`initialized:true` + salt → enter passphrase → `vault/unlock` → `setMasterKey` → `/vault`.

**Email/passphrase users:** unchanged (register → unlock → login as today).

Setting a vault passphrase on first Google login is **mandatory** — nothing can be
encrypted without it in this model. The `/vault` (and other record) pages already
redirect to `/unlock` when no master key is in memory, which naturally enforces this.

## Error handling

- Missing/invalid/expired `state` or PKCE cookie at callback → discard and restart the
  flow (redirect to `/unlock` with a generic "please try again").
- Google `email_verified !== true` → refuse account creation.
- Email collision with an existing passphrase account → friendly "use your passphrase;
  linking coming later" (no silent merge).
- `vault/init` when already initialized → `409`.
- Wrong passphrase at `vault/unlock` → `401`, same as today.
- Guard the existing email `/api/auth/login`: a Google-only user (`authVerifierHash == null`)
  attempting email login → `401` (cannot bcrypt-verify a null hash).

## Testing

- **Unit:** `oauth-google` ID-token verification (mocked JWKS / injected verifier);
  callback find-or-create resolution (stubbed verifier covering: new googleId, existing
  googleId, email-collision-with-passphrase-account, unverified email); `vault/init`
  (first-time vs already-initialized 409) and `vault/unlock` (match/mismatch) route logic;
  email-login guard for null `authVerifierHash`.
- **Live e2e:** the **vault half** is fully testable session-based without Google — create
  a session for a googleId-only user, then `vault/status` (initialized:false) → `vault/init`
  → `vault/status` (initialized:true, returns salt) → `vault/unlock` round-trip; assert the
  stored `authVerifierHash` is a bcrypt hash (starts with `$2`), never the raw verifier, and
  that no master key / passphrase is ever sent to the server. The **Google identity step**
  is exercised through the injectable verifier seam (real Google consent cannot run in the
  headless e2e harness).

## Environment / prerequisite (operator action, not code)

Create an **OAuth 2.0 Client ID** in Google Cloud Console with the authorized redirect URI
`<base-url>/api/auth/google/callback`. Provide `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`;
the plan will add them to `.env`, `.env.test`, and `.env.example`, plus a new
`APP_BASE_URL` (e.g. `http://localhost:3000` locally) used to build the redirect URI.
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are server-only secrets (never shipped to the
client).

## Out of scope (future slices)

- Linking Google to a pre-existing email/passphrase account.
- Other social providers.
- Account recovery / passphrase reset (a Google user who forgets the vault passphrase
  cannot decrypt — same as email users today; recovery is a separate backlog item).
