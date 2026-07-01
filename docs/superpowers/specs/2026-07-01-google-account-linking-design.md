# Google Account-Linking — design

**Date:** 2026-07-01
**Status:** Approved (design phase)

Let an existing **email + passphrase** account attach a **Google identity**, so future
"Continue with Google" reaches the same vault. Fills the gap deferred by the Google
Sign-In slice (see `2026-06-29-google-signin-design.md`), whose callback currently
dead-ends email collisions with *"use your passphrase — linking coming later."*

## Key insight — this is an identity operation, not a crypto one

The master key derives from the **vault passphrase** (`PBKDF2(passphrase, kdfSalt, 600k)`),
never from Google. Google establishes only *identity/session*. Therefore linking Google
to an existing account **does not touch the master key, ciphertext, IVs, or any key
material** — a linked Google user still enters their vault passphrase at `/unlock` to
decrypt. The zero-knowledge invariant is untouched by construction; nothing is
re-encrypted.

## Scope (locked from brainstorming)

**In scope:**
- **Link Google → existing password account**, initiated from a logged-in settings page.
- **Link on collision**: when a plain Google login hits an existing password email, offer
  an inline "enter your passphrase to link" flow instead of the current dead-end.
- **Unlink Google**, from the settings page (guarded against self-lockout).

**Out of scope (future slices):**
- Adding an email/passphrase login to a **Google-only** account (the reverse direction).
- Other social providers.
- Passphrase reset / account recovery.

## Authorization posture (locked)

Linking or unlinking **always requires the vault passphrase**, even when already logged
in (re-auth). This blunts session-hijack persistence: a stolen session alone cannot
quietly add a backdoor sign-in method. Concretely, link/unlink endpoints require a fresh
`authVerifier` (derived client-side from the passphrase) which is bcrypt-verified
server-side via the existing `verifyVerifier` — exactly like login. Linking therefore
requires **both**:
1. a **Google-verified identity** (proves ownership of the Google account), and
2. the **passphrase** (proves ownership of the Legacy account).

No account is ever auto-linked on a mere email match.

## Architecture — unified "verify-identity → confirm-with-passphrase"

Both link paths converge on one final step; only the entry point differs.

1. Obtain a Google-verified identity (existing OAuth authorization-code + PKCE dance).
2. Server sets a short-lived **pending-link cookie** carrying `{ googleId, email }`.
3. A confirm step collects the passphrase, derives `authVerifier`, and POSTs to
   `/api/auth/google/link`, which re-auths and attaches the `googleId`.

**Alternative considered — passphrase-first, then Google:** collect the passphrase before
redirecting to Google. Rejected: it still needs a cross-round-trip cookie *and* splits the
two entry points into different flows (more code, two confirm UIs).

## Data model

**No migration.** `User.googleId` (`String? @unique`) already exists from the Google
Sign-In slice. Link = set it; unlink = null it. No change to `Session`, `User` columns,
or any encrypted-record table.

### The pending-link cookie

Carries the Google-verified identity across the confirm step.

- Contents: `{ googleId, email, exp }`, HMAC-signed with a server secret.
- Attributes: `httpOnly`, `Secure`, `SameSite=Lax`, TTL ~5 minutes.
- Safe because it is **only ever set by our server after real Google ID-token
  verification**; a browser will not let another origin or client script set it, so its
  `googleId` is always one the requester genuinely owns. The HMAC is belt-and-suspenders
  (matches the codebase's careful posture) so a tampered value is rejected outright.
- Signing secret: a new server-only env var (e.g. `LINK_STATE_SECRET`), added to `.env`,
  `.env.test`, `.env.example`. Route fails closed if absent (mirrors `SURVIVOR_SALT_SECRET`).

## Endpoints

- **`GET /api/auth/google/start`** *(extend existing)* — accept `?intent=link`; record the
  intent (`login` default vs `link`) in the state cookie alongside the PKCE verifier.
- **`GET /api/auth/google/callback`** *(extend existing)* — after verifying the ID token
  (`email_verified === true` required):
  - `intent=login`, new/known Google user → unchanged (find-or-create + session).
  - `intent=login`, **email collides** with an existing password account
    (`googleId == null`) → set pending-link cookie, redirect to the collision-confirm view
    (was: dead-end message).
  - `intent=link` → set pending-link cookie, redirect to `/account?link=confirm`.
- **`POST /api/auth/google/link`** — body `{ authVerifier }` **only** (the target account is
  never client-supplied — see step 2).
  1. Read + verify the pending-link cookie (400 if missing/expired/bad-HMAC); it yields the
     trusted `{ googleId, email }`.
  2. Resolve the target account **server-side**: the current session's user if logged in;
     else by the **cookie's** `email` (the collision case). The client cannot dictate which
     account is linked.
  3. `verifyVerifier(authVerifier, user.authVerifierHash)` → generic 401 on mismatch (and
     on null hash — a Google-only account cannot be a link target here).
  4. If the user already has a `googleId` → 409 (no silent overwrite).
  5. Set `user.googleId` = the cookie's `googleId`; unique violation → 409 "already linked
     elsewhere." (A logged-in user may link a Google account whose email differs from their
     own — the session proves ownership; only the cookie's `googleId` is attached.)
  6. Create a session if none exists; clear the pending-link cookie; return `{ ok: true }`.
- **`GET /api/auth/google/pending`** — reads the pending-link cookie and returns
  `{ email }` (or `{ email: null }` when absent/invalid) so the **not-logged-in**
  collision-confirm view can display which Google email is being linked without reading the
  `httpOnly` cookie from JS. Display-only; never used for target resolution.
- **`POST /api/auth/google/unlink`** — body `{ authVerifier }`, session-scoped. Re-auth via
  `verifyVerifier`; refuse if `authVerifierHash == null` (409 — would strand the user);
  else set `googleId = null`.
- **`GET /api/account/status`** — session-scoped `{ email, googleLinked, hasPassword }` to
  drive the account page (`hasPassword` = `authVerifierHash != null`).

## UI

**New page `/account`** (nav link in `AppNav`, calm brand kit). Session-gated like other
pages; renders from `GET /api/account/status`:
- Shows account email and Google-linked state.
- **Not linked:** "Link Google" → navigates to `/api/auth/google/start?intent=link`.
- **Linked:** linked indicator + "Unlink Google" (shown only when `hasPassword`).
- **`?link=confirm`:** confirm panel — "Confirm linking `<google-email>` — enter your vault
  passphrase" → derive `authVerifier` client-side → `POST /api/auth/google/link` → success
  re-renders as linked.

**Client (`src/lib/api-client.ts`):** add `accountStatus()`, `pendingLink()`,
`googleLink(authVerifier)`, `googleUnlink(authVerifier)`. Google `start`/`callback` remain
plain browser navigations.

## Flows

**A — Link from settings (logged in):** `/account` → "Link Google" → consent → callback
sets pending-link cookie → `/account?link=confirm` → enter passphrase → `/link` →
re-render linked.

**B — Link on collision (not logged in):** `/unlock` → "Continue with Google" → callback
detects email collision → pending-link cookie → collision-confirm view on `/unlock`
(`?link=confirm`; fetches the display email via `GET /api/auth/google/pending`) → "This
email already has an account. Enter your passphrase to link Google." → `/link` (resolves the
target from the cookie's email, creates session). The passphrase
entered here is the same one that derives the master key, so the confirm step derives
**both** the `authVerifier` (sent) and the master key (into `KeyProvider`, never sent),
landing the user in an unlocked `/vault` with no second prompt.

**C — Unlink (logged in):** `/account` → "Unlink Google" → passphrase prompt → `/unlink` →
re-render not-linked.

## Error handling

- Invalid/expired/missing `state` or PKCE cookie at callback → discard, restart, generic
  "please try again" (existing).
- Google `email_verified !== true` → refuse (existing).
- Pending-link cookie missing/expired/bad-HMAC at `/link` → 400 "linking session expired,
  start again."
- `googleId` already linked to another account (unique violation) → 409 "that Google
  account is already linked elsewhere."
- Session user already has a `googleId` at `/link` → 409 "already linked."
- Wrong passphrase at `/link` or `/unlink` → generic 401 (same wording as login).
- Unlink when `authVerifierHash == null` → 409 "set a passphrase first."
- Missing `LINK_STATE_SECRET` → route fails closed (500), mirroring `SURVIVOR_SALT_SECRET`.

## Testing

**Unit:**
- Pending-link cookie helper: sign / verify / reject-tampered / reject-expired.
- `/link` resolution matrix: logged-in (session) vs cookie-email target; passphrase
  match/mismatch (401); null `authVerifierHash` target (401); `googleId` already taken
  (409); session user already linked (409); missing/expired/bad-HMAC cookie (400).
- `/pending` returns the cookie email when present, `null` when absent/invalid.
- `/unlink`: success; no-password guard (409); wrong passphrase (401).
- `callback` branching via the existing injectable ID-token verifier seam: login-new,
  login-collision → confirm redirect + cookie set, `intent=link` → confirm redirect.
- `/api/account/status` shape (email, googleLinked, hasPassword).
- Fail-closed when `LINK_STATE_SECRET` is unset.

**Live e2e** (session-based, no real Google — the Google identity step uses the injectable
verifier seam, real consent can't run headless):
- Seed a password account; mint a valid pending-link cookie via the signing helper; `POST
  /link` with the derived `authVerifier`; assert `googleId` is set and **no passphrase,
  master key, or plaintext** was sent to the server.
- `POST /unlink` clears `googleId`.
- Wrong passphrase → 401; no-password unlink → 409; tampered/expired cookie → 400.

## Environment / prerequisite (operator action)

Add **`LINK_STATE_SECRET`** (server-only) to `.env`, `.env.test`, `.env.example`, and the
prod env before deploy. Reuses the already-configured `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET` / `APP_BASE_URL` from the Google Sign-In slice; no new Google Cloud
configuration is required (same redirect URI).
