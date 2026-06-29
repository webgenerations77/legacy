# Google Sign-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Continue with Google" as a second sign-up/sign-in path alongside email+passphrase, where Google establishes the session and a separate vault passphrase still derives the encryption key client-side (zero-knowledge unchanged).

**Architecture:** Manual OIDC (authorization-code + PKCE) via `arctic`, ID-token verification via `jose`, wired into the app's existing custom `Session` model. New Google users get a `User` row with `googleId` and null `kdfSalt`/`authVerifierHash`; they set a vault passphrase on first sign-in through session-scoped `vault/status|init|unlock` routes. The crypto lib is untouched.

**Tech Stack:** Next.js 16 (App Router, TS strict), Prisma 6 → Railway Postgres, `arctic` (OAuth2/Google), `jose` (JWT/JWKS), bcryptjs, WebCrypto, Vitest.

## Global Constraints

- **Zero-knowledge (do not break):** the passphrase and master key never leave the browser; the server stores only `kdfSalt`, `bcrypt(authVerifier)`, ciphertext, IVs. Google provides identity only.
- **Nullable vault fields:** `User.kdfSalt` and `User.authVerifierHash` become `String?`; `kdfSalt == null` ⇔ vault not yet initialized. Existing email users keep non-null values.
- **OAuth mechanism:** manual OIDC with `arctic` + `jose` into the existing `createSession`/`SESSION_COOKIE`. Do NOT add next-auth/Auth.js.
- **Account linking deferred:** a Google sign-in whose email matches an existing passphrase account is refused with an "email_exists" message — never auto-merged.
- **Verified email required:** reject Google identities with `email_verified !== true`.
- **Google secrets are server-only:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_BASE_URL` live in env, never shipped to the client.
- **One migration, both DBs:** apply to dev (`.env`) and test (`.env.test`); commit the migration file.
- **Verification gates (end):** `npm test` → `npx tsc --noEmit` → `npm run build` → live e2e (`npx vitest run --config vitest.e2e.config.ts` against a running `npm run dev` + dev DB).
- **Windows/Turbopack:** if `/api/*` 404s under dev, stop the server, delete `.next`, restart (stop before deleting `.next` to avoid EPERM).

---

### Task 1: Schema — nullable vault fields + googleId, migration (both DBs)

**Files:**
- Modify: `prisma/schema.prisma` (User model)
- Create: `prisma/migrations/<timestamp>_google_signin/migration.sql` (generated)

**Interfaces:**
- Consumes: nothing.
- Produces: `User.googleId String? @unique`; `User.kdfSalt String?`; `User.authVerifierHash String?`. The `prisma.user` delegate now accepts/returns these as nullable.

- [ ] **Step 1: Edit the User model**

In `prisma/schema.prisma`, change the `User` model's three fields. Replace:

```prisma
model User {
  id               String      @id @default(cuid())
  email            String      @unique
  kdfSalt          String
  authVerifierHash String
  createdAt        DateTime    @default(now())
```

with:

```prisma
model User {
  id               String      @id @default(cuid())
  email            String      @unique
  googleId         String?     @unique
  kdfSalt          String?
  authVerifierHash String?
  createdAt        DateTime    @default(now())
```

(Leave the relation fields — sessions, vaultItems, financialAccounts, bills, loans, beneficiaries — unchanged.)

- [ ] **Step 2: Create + apply the migration to the dev DB**

Run: `npx prisma migrate dev --name google_signin`
Expected: creates `prisma/migrations/<timestamp>_google_signin/migration.sql`, applies it to the dev DB, regenerates the client. The SQL should resemble:

```sql
-- AlterTable
ALTER TABLE "User" ADD COLUMN "googleId" TEXT,
ALTER COLUMN "kdfSalt" DROP NOT NULL,
ALTER COLUMN "authVerifierHash" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
```

If Prisma reports a Windows EPERM on the post-migrate `generate` (DLL lock), it is cosmetic — the migration + types are written; note it and continue.

- [ ] **Step 3: Apply the migration to the test DB**

Run: `npx dotenv -e .env.test -- npx prisma migrate deploy`
Expected: "1 migration applied" against the test DB; no reset.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: PASS (client regenerated; `user.kdfSalt` is now `string | null`). Note: this may surface type errors in `salt`/`login` routes that read these fields — those are fixed in Task 4; if `tsc` flags ONLY those two files, that is expected at this step.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: make User vault fields nullable, add googleId"
```

---

### Task 2: Google OAuth lib (`arctic` + `jose`) + env

**Files:**
- Modify: `package.json` (add `arctic`, `jose`)
- Modify: `.env`, `.env.test`, `.env.example` (add Google + base-url vars)
- Create: `src/lib/oauth-google.ts`
- Test: `src/lib/oauth-google.test.ts`

**Interfaces:**
- Consumes: env `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_BASE_URL`.
- Produces:
  - `interface GoogleIdentity { googleId: string; email: string; emailVerified: boolean }`
  - `createGoogleAuthUrl(state: string, codeVerifier: string): URL`
  - `verifyGoogleIdToken(idToken: string, opts?: { keySet?: import("jose").JWTVerifyGetKey | CryptoKey; issuer?: string | string[]; audience?: string }): Promise<GoogleIdentity>`
  - `resolveGoogleIdentity(code: string, codeVerifier: string): Promise<GoogleIdentity>`

- [ ] **Step 1: Install dependencies**

Run: `npm install arctic jose`
Expected: both added to `package.json` dependencies; lockfile updated.

- [ ] **Step 2: Add env vars**

Append to `.env.example`:

```
# Google OAuth (server-only). Create an OAuth 2.0 Client ID in Google Cloud Console;
# set the authorized redirect URI to <APP_BASE_URL>/api/auth/google/callback.
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
APP_BASE_URL="http://localhost:3000"
```

Append the same three keys to `.env` and `.env.test` with placeholder values (`GOOGLE_CLIENT_ID="placeholder"`, `GOOGLE_CLIENT_SECRET="placeholder"`, `APP_BASE_URL="http://localhost:3000"`) so the dev/test server boots. Real values are supplied by the operator later; the OAuth start/callback routes are the only code that needs real values, and they are not exercised by automated tests.

- [ ] **Step 3: Write the failing test**

Create `src/lib/oauth-google.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { SignJWT, generateKeyPair } from "jose";
import { createGoogleAuthUrl, verifyGoogleIdToken } from "@/lib/oauth-google";

let privateKey: CryptoKey;
let publicKey: CryptoKey;

beforeAll(async () => {
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  process.env.APP_BASE_URL = "http://localhost:3000";
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
});

async function signIdToken(claims: Record<string, unknown>, sub = "google-sub-123") {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(sub)
    .setIssuer("https://accounts.google.com")
    .setAudience("test-client-id")
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe("oauth-google", () => {
  it("builds a Google authorization URL with the expected params", () => {
    const url = createGoogleAuthUrl("state-xyz", "verifier-abc");
    expect(url.host).toBe("accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/auth/google/callback",
    );
    expect(url.searchParams.get("state")).toBe("state-xyz");
    expect(url.searchParams.get("scope")).toContain("email");
    expect(url.searchParams.get("code_challenge")).toBeTruthy(); // PKCE
  });

  it("verifies a well-formed Google ID token and extracts identity", async () => {
    const token = await signIdToken({ email: "jane@example.com", email_verified: true });
    const id = await verifyGoogleIdToken(token, { keySet: publicKey, audience: "test-client-id" });
    expect(id).toEqual({
      googleId: "google-sub-123",
      email: "jane@example.com",
      emailVerified: true,
    });
  });

  it("reports emailVerified=false when the claim is not true", async () => {
    const token = await signIdToken({ email: "jane@example.com", email_verified: false });
    const id = await verifyGoogleIdToken(token, { keySet: publicKey, audience: "test-client-id" });
    expect(id.emailVerified).toBe(false);
  });

  it("rejects a token signed by the wrong key", async () => {
    const wrong = await generateKeyPair("RS256");
    const token = await new SignJWT({ email: "x@example.com", email_verified: true })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("s")
      .setIssuer("https://accounts.google.com")
      .setAudience("test-client-id")
      .setExpirationTime("5m")
      .sign(wrong.privateKey);
    await expect(
      verifyGoogleIdToken(token, { keySet: publicKey, audience: "test-client-id" }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/lib/oauth-google.test.ts`
Expected: FAIL — cannot resolve `@/lib/oauth-google`.

- [ ] **Step 5: Write the implementation**

Create `src/lib/oauth-google.ts`:

```ts
import { Google } from "arctic";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface GoogleIdentity {
  googleId: string;
  email: string;
  emailVerified: boolean;
}

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function redirectUri(): string {
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  return `${base}/api/auth/google/callback`;
}

function googleClient(): Google {
  return new Google(reqEnv("GOOGLE_CLIENT_ID"), reqEnv("GOOGLE_CLIENT_SECRET"), redirectUri());
}

export function createGoogleAuthUrl(state: string, codeVerifier: string): URL {
  return googleClient().createAuthorizationURL(state, codeVerifier, ["openid", "email", "profile"]);
}

const GOOGLE_JWKS: JWTVerifyGetKey = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

export async function verifyGoogleIdToken(
  idToken: string,
  opts?: { keySet?: JWTVerifyGetKey | CryptoKey; issuer?: string | string[]; audience?: string },
): Promise<GoogleIdentity> {
  const keySet = opts?.keySet ?? GOOGLE_JWKS;
  const issuer = opts?.issuer ?? ["https://accounts.google.com", "accounts.google.com"];
  const audience = opts?.audience ?? reqEnv("GOOGLE_CLIENT_ID");
  const { payload } = await jwtVerify(idToken, keySet, { issuer, audience });
  const googleId = typeof payload.sub === "string" ? payload.sub : "";
  const email = typeof payload.email === "string" ? payload.email : "";
  const emailVerified = payload.email_verified === true;
  if (!googleId || !email) throw new Error("Invalid Google identity token.");
  return { googleId, email, emailVerified };
}

// Network step (token exchange + verify). Thin glue; exercised end-to-end manually
// and via the callback route — not unit-tested (needs a live Google token endpoint).
export async function resolveGoogleIdentity(
  code: string,
  codeVerifier: string,
): Promise<GoogleIdentity> {
  const tokens = await googleClient().validateAuthorizationCode(code, codeVerifier);
  return verifyGoogleIdToken(tokens.idToken());
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/lib/oauth-google.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .env.example src/lib/oauth-google.ts src/lib/oauth-google.test.ts
git commit -m "feat: add google oauth lib (auth url, id-token verify) + deps"
```

(`.env`/`.env.test` are gitignored — they are updated locally but not committed.)

---

### Task 3: `findOrCreateGoogleUser` (DB resolution)

**Files:**
- Create: `src/lib/google-user.ts`
- Test: `src/lib/google-user.test.ts`

**Interfaces:**
- Consumes: `prisma` (`@/lib/db`); a `GoogleIdentity`-shaped `{ googleId, email }`.
- Produces:
  - `type GoogleUserResult = { ok: true; userId: string } | { ok: false; reason: "email_taken" }`
  - `findOrCreateGoogleUser(identity: { googleId: string; email: string }): Promise<GoogleUserResult>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/google-user.test.ts` (runs under `npm test`, hits the test DB via `.env.test` — mirrors `src/lib/auth.test.ts`):

```ts
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { findOrCreateGoogleUser } from "@/lib/google-user";

const emails: string[] = [];
function freshEmail(tag: string) {
  const e = `g-${tag}-${Date.now()}@example.com`;
  emails.push(e);
  return e;
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

describe("findOrCreateGoogleUser", () => {
  it("creates a new user for an unseen googleId, with null vault fields", async () => {
    const email = freshEmail("new");
    const googleId = `gid-new-${Date.now()}`;
    const res = await findOrCreateGoogleUser({ googleId, email });
    expect(res.ok).toBe(true);
    const user = await prisma.user.findUnique({ where: { googleId } });
    expect(user?.email).toBe(email);
    expect(user?.kdfSalt).toBeNull();
    expect(user?.authVerifierHash).toBeNull();
  });

  it("returns the same user id for a repeated googleId (idempotent)", async () => {
    const email = freshEmail("repeat");
    const googleId = `gid-repeat-${Date.now()}`;
    const first = await findOrCreateGoogleUser({ googleId, email });
    const second = await findOrCreateGoogleUser({ googleId, email });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.userId).toBe(first.userId);
  });

  it("refuses when the email already belongs to a passphrase account (linking deferred)", async () => {
    const email = freshEmail("taken");
    await prisma.user.create({ data: { email, kdfSalt: "s", authVerifierHash: "h" } });
    const res = await findOrCreateGoogleUser({ googleId: `gid-taken-${Date.now()}`, email });
    expect(res).toEqual({ ok: false, reason: "email_taken" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/google-user.test.ts`
Expected: FAIL — cannot resolve `@/lib/google-user`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/google-user.ts`:

```ts
import { prisma } from "@/lib/db";

export type GoogleUserResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "email_taken" };

export async function findOrCreateGoogleUser(identity: {
  googleId: string;
  email: string;
}): Promise<GoogleUserResult> {
  const email = identity.email.trim().toLowerCase();

  const byGoogle = await prisma.user.findUnique({ where: { googleId: identity.googleId } });
  if (byGoogle) return { ok: true, userId: byGoogle.id };

  const byEmail = await prisma.user.findUnique({ where: { email } });
  if (byEmail) return { ok: false, reason: "email_taken" };

  const created = await prisma.user.create({ data: { googleId: identity.googleId, email } });
  return { ok: true, userId: created.id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/google-user.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/google-user.ts src/lib/google-user.test.ts
git commit -m "feat: add findOrCreateGoogleUser (deferred email linking)"
```

---

### Task 4: OAuth routes + nullable-field guards on existing routes

**Files:**
- Create: `src/app/api/auth/google/start/route.ts`
- Create: `src/app/api/auth/google/callback/route.ts`
- Modify: `src/app/api/auth/login/route.ts` (guard null `authVerifierHash`)
- Modify: `src/app/api/auth/salt/route.ts` (guard null `kdfSalt`)

**Interfaces:**
- Consumes: `createGoogleAuthUrl`, `resolveGoogleIdentity` (Task 2); `findOrCreateGoogleUser` (Task 3); `createSession`, `SESSION_COOKIE`, `sessionCookieOptions`, `sessionExpiry` (existing); `generateState`, `generateCodeVerifier` (arctic).
- Produces: `GET /api/auth/google/start` (302 to Google, sets state+PKCE cookies); `GET /api/auth/google/callback` (validates, creates session, redirects to `/unlock` or `/unlock?error=...`). Hardened `login`/`salt`.

- [ ] **Step 1: Create the start route**

Create `src/app/api/auth/google/start/route.ts`:

```ts
import { NextResponse } from "next/server";
import { generateState, generateCodeVerifier } from "arctic";
import { createGoogleAuthUrl } from "@/lib/oauth-google";

const TEN_MINUTES = 600;

export async function GET() {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const url = createGoogleAuthUrl(state, codeVerifier);

  const res = NextResponse.redirect(url);
  const opts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: TEN_MINUTES,
  };
  res.cookies.set("google_oauth_state", state, opts);
  res.cookies.set("google_code_verifier", codeVerifier, opts);
  return res;
}
```

- [ ] **Step 2: Create the callback route**

Create `src/app/api/auth/google/callback/route.ts`:

```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { resolveGoogleIdentity } from "@/lib/oauth-google";
import { findOrCreateGoogleUser } from "@/lib/google-user";
import { createSession } from "@/lib/auth";
import { SESSION_COOKIE, sessionCookieOptions, sessionExpiry } from "@/lib/session-cookie";

function appBaseUrl(): string {
  return process.env.APP_BASE_URL ?? "http://localhost:3000";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const jar = await cookies();
  const storedState = jar.get("google_oauth_state")?.value;
  const codeVerifier = jar.get("google_code_verifier")?.value;

  const fail = (reason: string) =>
    NextResponse.redirect(new URL(`/unlock?error=${reason}`, appBaseUrl()));

  if (!code || !state || !storedState || !codeVerifier || state !== storedState) {
    return fail("google_failed");
  }

  let identity;
  try {
    identity = await resolveGoogleIdentity(code, codeVerifier);
  } catch {
    return fail("google_failed");
  }
  if (!identity.emailVerified) return fail("google_unverified");

  const result = await findOrCreateGoogleUser(identity);
  if (!result.ok) return fail("email_exists");

  const sessionId = await createSession(result.userId);
  const res = NextResponse.redirect(new URL("/unlock", appBaseUrl()));
  res.cookies.set(SESSION_COOKIE, sessionId, sessionCookieOptions(sessionExpiry()));
  res.cookies.delete("google_oauth_state");
  res.cookies.delete("google_code_verifier");
  return res;
}
```

- [ ] **Step 3: Guard the login route for null authVerifierHash**

In `src/app/api/auth/login/route.ts`, replace:

```ts
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return generic;
  if (!(await verifyVerifier(authVerifier, user.authVerifierHash))) return generic;
```

with:

```ts
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.authVerifierHash) return generic;
  if (!(await verifyVerifier(authVerifier, user.authVerifierHash))) return generic;
```

- [ ] **Step 4: Guard the salt route for null kdfSalt**

In `src/app/api/auth/salt/route.ts`, replace:

```ts
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json({ salt: user.kdfSalt });
```

with:

```ts
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.kdfSalt) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json({ salt: user.kdfSalt });
```

- [ ] **Step 5: Typecheck and build**

Run: `npx tsc --noEmit`
Expected: PASS (the null-guards satisfy the nullable types from Task 1).

Run: `npm run build`
Expected: PASS; `/api/auth/google/start` and `/api/auth/google/callback` appear in the route list.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/auth/google src/app/api/auth/login/route.ts src/app/api/auth/salt/route.ts
git commit -m "feat: add google oauth start/callback routes; guard nullable vault fields"
```

---

### Task 5: Vault status/init/unlock routes + api-client methods

**Files:**
- Create: `src/app/api/auth/vault/status/route.ts`
- Create: `src/app/api/auth/vault/init/route.ts`
- Create: `src/app/api/auth/vault/unlock/route.ts`
- Modify: `src/lib/api-client.ts` (add `vaultStatus`, `vaultInit`, `vaultUnlock`)

**Interfaces:**
- Consumes: `getSessionUserId`, `SESSION_COOKIE`, `hashVerifier`, `verifyVerifier`, `readJsonBody`, `prisma`.
- Produces:
  - `GET /api/auth/vault/status` → `{ initialized: boolean, salt?: string }` (401 if no session)
  - `POST /api/auth/vault/init` `{ salt, authVerifier }` → `{ ok: true }` (409 if already initialized)
  - `POST /api/auth/vault/unlock` `{ authVerifier }` → `{ ok: true }` (401 on mismatch)
  - api-client: `vaultStatus(): Promise<{ initialized: boolean; salt?: string } | null>` (null on 401); `vaultInit(salt, authVerifier)`; `vaultUnlock(authVerifier)`

- [ ] **Step 1: Create the status route**

Create `src/app/api/auth/vault/status/route.ts`:

```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session-cookie";

export async function GET() {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  const userId = await getSessionUserId(sid);
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { kdfSalt: true } });
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  return NextResponse.json({ initialized: user.kdfSalt != null, salt: user.kdfSalt ?? undefined });
}
```

- [ ] **Step 2: Create the init route**

Create `src/app/api/auth/vault/init/route.ts`:

```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getSessionUserId, hashVerifier } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import { readJsonBody } from "@/lib/http";

export async function POST(req: Request) {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  const userId = await getSessionUserId(sid);
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const salt = typeof body.salt === "string" ? body.salt : "";
  const authVerifier = typeof body.authVerifier === "string" ? body.authVerifier : "";
  if (!salt || !authVerifier) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { kdfSalt: true } });
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (user.kdfSalt != null) {
    return NextResponse.json({ error: "Vault already initialized." }, { status: 409 });
  }

  await prisma.user.update({
    where: { id: userId },
    data: { kdfSalt: salt, authVerifierHash: await hashVerifier(authVerifier) },
  });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Create the unlock route**

Create `src/app/api/auth/vault/unlock/route.ts`:

```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getSessionUserId, verifyVerifier } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import { readJsonBody } from "@/lib/http";

export async function POST(req: Request) {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  const userId = await getSessionUserId(sid);
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const authVerifier = typeof body.authVerifier === "string" ? body.authVerifier : "";

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { authVerifierHash: true },
  });
  if (!user || !user.authVerifierHash) {
    return NextResponse.json({ error: "Vault not set up." }, { status: 401 });
  }
  if (!(await verifyVerifier(authVerifier, user.authVerifierHash))) {
    return NextResponse.json({ error: "That passphrase didn't match." }, { status: 401 });
  }
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Add api-client methods**

In `src/lib/api-client.ts`, add these three methods to the `api` object (after `logout`):

```ts
  vaultStatus: async () => {
    const res = await fetch("/api/auth/vault/status");
    if (res.status === 401) return null;
    if (!res.ok) throw new Error("We couldn't check your vault status.");
    return res.json() as Promise<{ initialized: boolean; salt?: string }>;
  },
  vaultInit: (salt: string, authVerifier: string) =>
    post<{ ok: true }>("/api/auth/vault/init", { salt, authVerifier }),
  vaultUnlock: (authVerifier: string) =>
    post<{ ok: true }>("/api/auth/vault/unlock", { authVerifier }),
```

- [ ] **Step 5: Typecheck and build**

Run: `npx tsc --noEmit`
Expected: PASS.

Run: `npm run build`
Expected: PASS; the three `/api/auth/vault/*` routes appear in the route list.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/auth/vault src/lib/api-client.ts
git commit -m "feat: add vault status/init/unlock routes + api-client methods"
```

---

### Task 6: UI — Google button + unlock set/enter branching

**Files:**
- Modify: `src/app/register/page.tsx` (add "Continue with Google")
- Modify: `src/app/unlock/page.tsx` (Google button + set-vs-enter modes + error banner)

**Interfaces:**
- Consumes: `api.vaultStatus`, `api.vaultInit`, `api.vaultUnlock`, `api.getSalt`, `api.login` (existing); `generateSalt`, `deriveMasterKey`, `deriveAuthVerifier`; `useKey`.
- Produces: the two updated pages. No new exports.

- [ ] **Step 1: Add the Google button to register**

In `src/app/register/page.tsx`, add a divider + link immediately AFTER the closing `</button>` of the submit button (before `{error && ...}`):

```tsx
        <p className="subtle" style={{ textAlign: "center", margin: "0.5rem 0" }}>or</p>
        <a className="linkbtn" href="/api/auth/google/start">Continue with Google</a>
```

- [ ] **Step 2: Rewrite the unlock page with mode branching**

Replace the entire contents of `src/app/unlock/page.tsx` with:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api-client";
import { BrandHeader } from "@/components/Logo";
import { useKey } from "@/app/providers/KeyProvider";
import { generateSalt, deriveMasterKey, deriveAuthVerifier } from "@/lib/crypto";

type Mode = "loading" | "email" | "create" | "enter";

const ERRORS: Record<string, string> = {
  email_exists:
    "An account with that email already exists. Sign in with your passphrase below (Google linking is coming soon).",
  google_failed: "Google sign-in didn't complete. Please try again.",
  google_unverified: "Your Google email isn't verified, so we can't create an account.",
};

export default function UnlockPage() {
  const router = useRouter();
  const { setMasterKey } = useKey();
  const [mode, setMode] = useState<Mode>("loading");
  const [salt, setSalt] = useState("");
  const [email, setEmail] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("error");
    if (q && ERRORS[q]) setError(ERRORS[q]);
    api
      .vaultStatus()
      .then((status) => {
        if (status === null) {
          setMode("email");
        } else if (status.initialized) {
          setSalt(status.salt ?? "");
          setMode("enter");
        } else {
          setMode("create");
        }
      })
      .catch(() => setMode("email"));
  }, []);

  async function onEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { salt: s } = await api.getSalt(email).catch(() => {
        throw new Error("That email or passphrase didn't match.");
      });
      const masterKey = await deriveMasterKey(passphrase, s);
      const authVerifier = await deriveAuthVerifier(masterKey, passphrase);
      await api.login(email, authVerifier);
      setMasterKey(masterKey);
      router.push("/vault");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function onCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const s = generateSalt();
      const masterKey = await deriveMasterKey(passphrase, s);
      const authVerifier = await deriveAuthVerifier(masterKey, passphrase);
      await api.vaultInit(s, authVerifier);
      setMasterKey(masterKey);
      router.push("/vault");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function onEnterSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const masterKey = await deriveMasterKey(passphrase, salt);
      const authVerifier = await deriveAuthVerifier(masterKey, passphrase);
      await api.vaultUnlock(authVerifier).catch(() => {
        throw new Error("That passphrase didn't match.");
      });
      setMasterKey(masterKey);
      router.push("/vault");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (mode === "loading") {
    return (
      <main className="center">
        <div className="card">
          <BrandHeader />
          <p className="subtle">Loading…</p>
        </div>
      </main>
    );
  }

  if (mode === "create") {
    return (
      <main className="center">
        <form className="card" onSubmit={onCreateSubmit}>
          <BrandHeader />
          <h1>Set your vault passphrase</h1>
          <p className="subtle">
            This passphrase encrypts everything on your device. We never see it, and it
            can&apos;t be recovered — choose something memorable.
          </p>
          <label htmlFor="pass">Passphrase</label>
          <input id="pass" type="password" value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)} required minLength={8} />
          <button type="submit" disabled={busy}>
            {busy ? "Setting up…" : "Create vault"}
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      </main>
    );
  }

  if (mode === "enter") {
    return (
      <main className="center">
        <form className="card" onSubmit={onEnterSubmit}>
          <BrandHeader />
          <h1>Welcome back</h1>
          <p className="subtle">Enter your vault passphrase to unlock your vault.</p>
          <label htmlFor="pass">Passphrase</label>
          <input id="pass" type="password" value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)} required />
          <button type="submit" disabled={busy}>
            {busy ? "Unlocking…" : "Unlock"}
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      </main>
    );
  }

  // mode === "email"
  return (
    <main className="center">
      <form className="card" onSubmit={onEmailSubmit}>
        <BrandHeader />
        <h1>Welcome back</h1>
        <p className="subtle">Enter your passphrase to unlock your vault.</p>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email}
          onChange={(e) => setEmail(e.target.value)} required />
        <label htmlFor="pass">Passphrase</label>
        <input id="pass" type="password" value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)} required />
        <button type="submit" disabled={busy}>
          {busy ? "Unlocking…" : "Unlock"}
        </button>
        <p className="subtle" style={{ textAlign: "center", margin: "0.5rem 0" }}>or</p>
        <a className="linkbtn" href="/api/auth/google/start">Continue with Google</a>
        {error && <p className="error">{error}</p>}
        <p className="link">New here? <Link href="/register">Create your Legacy</Link></p>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Typecheck and build**

Run: `npx tsc --noEmit`
Expected: PASS.

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/register/page.tsx src/app/unlock/page.tsx
git commit -m "feat: add Continue with Google button + unlock set/enter modes"
```

---

### Task 7: Live e2e — Google vault setup round-trip + guards + verification

**Files:**
- Modify: `e2e.spec.ts` (add a new `it(...)` block + imports)

**Interfaces:**
- Consumes: the live `/api/auth/vault/*` and `/api/auth/login` routes; crypto lib; the dev DB client `db`.
- Produces: a passing live e2e proving: a Google-session user can initialize and unlock a vault, the derived key encrypts a real record, the stored `authVerifierHash` is bcrypt (never plaintext), and a Google-only user (no vault yet) cannot use email login.

- [ ] **Step 1: Add the import**

In `e2e.spec.ts`, the file already imports `generateSalt, deriveMasterKey, deriveAuthVerifier, encryptItem, decryptItem` from `@/lib/crypto`. No new import is required. (The block below uses only those plus the `db` client and `fetch`.)

- [ ] **Step 2: Write the failing e2e block**

In `e2e.spec.ts`, add this block inside `describe("walking skeleton (live)", ...)`, after the beneficiary block:

```ts
  it("lets a Google-session user set up and unlock a vault (no plaintext stored)", async () => {
    const gEmail = `e2e-google-${Date.now()}@example.com`;
    const googleId = `gid-e2e-${Date.now()}`;
    const pass = "google-vault-passphrase-123";

    // Simulate the post-Google state: a user row with googleId and no vault yet,
    // plus a live session row. (The Google OAuth dance itself can't run headless.)
    const user = await db.user.create({ data: { email: gEmail, googleId } });
    const sessionId = `e2e-sess-${Date.now()}`;
    await db.session.create({
      data: { id: sessionId, userId: user.id, expiresAt: new Date(Date.now() + 3600_000) },
    });
    const cookie = `legacy_session=${sessionId}`;

    // status → not initialized
    const s1 = await fetch(`${BASE}/api/auth/vault/status`, { headers: { cookie } });
    expect(s1.status).toBe(200);
    expect(await s1.json()).toEqual({ initialized: false });

    // a Google-only user (no vault) cannot use the email/passphrase login
    const badLogin = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: gEmail, authVerifier: "anything" }),
    });
    expect(badLogin.status).toBe(401);

    // init the vault: derive client-side, send salt + authVerifier
    const salt = generateSalt();
    const mk = await deriveMasterKey(pass, salt);
    const av = await deriveAuthVerifier(mk, pass);
    const init = await fetch(`${BASE}/api/auth/vault/init`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ salt, authVerifier: av }),
    });
    expect(init.status).toBe(200);

    // init is one-shot: a second init is rejected
    const reinit = await fetch(`${BASE}/api/auth/vault/init`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ salt, authVerifier: av }),
    });
    expect(reinit.status).toBe(409);

    // status → initialized, returns the salt
    const s2 = await fetch(`${BASE}/api/auth/vault/status`, { headers: { cookie } });
    expect(await s2.json()).toEqual({ initialized: true, salt });

    // unlock: correct passphrase ok, wrong passphrase rejected
    const okUnlock = await fetch(`${BASE}/api/auth/vault/unlock`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ authVerifier: av }),
    });
    expect(okUnlock.status).toBe(200);
    const wrongMk = await deriveMasterKey("not-the-passphrase", salt);
    const wrongAv = await deriveAuthVerifier(wrongMk, "not-the-passphrase");
    const badUnlock = await fetch(`${BASE}/api/auth/vault/unlock`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ authVerifier: wrongAv }),
    });
    expect(badUnlock.status).toBe(401);

    // the derived key encrypts a real record through the existing record API
    const secret = "Google user's first encrypted note.";
    const enc = await encryptItem(mk, secret);
    const add = await fetch(`${BASE}/api/vault`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify(enc),
    });
    expect(add.status).toBe(201);
    const list = await fetch(`${BASE}/api/vault`, { headers: { cookie } });
    const { items } = await list.json();
    expect(await decryptItem(mk, items[0].ciphertext, items[0].iv)).toBe(secret);

    // ZERO-KNOWLEDGE: stored verifier is bcrypt, never the raw verifier or passphrase
    const stored = await db.user.findUnique({ where: { id: user.id } });
    expect(stored!.kdfSalt).toBe(salt);
    expect(stored!.authVerifierHash!.startsWith("$2")).toBe(true);
    expect(stored!.authVerifierHash).not.toBe(av);

    // cleanup
    await db.user.delete({ where: { id: user.id } });
  }, 60_000);
```

- [ ] **Step 3: Start the dev server (separate terminal)**

Run (own terminal, leave running): `npm run dev`
Expected: listening on `http://localhost:3000`. If `/api/*` 404s, stop, delete `.next`, restart.

- [ ] **Step 4: Run the live e2e**

Run: `npx vitest run --config vitest.e2e.config.ts`
Expected: PASS — all blocks pass, including "lets a Google-session user set up and unlock a vault".

- [ ] **Step 5: Commit**

```bash
git add e2e.spec.ts
git commit -m "test: add live e2e google vault setup round-trip + guards"
```

---

## Final verification (all gates)

- [ ] `npm test` — unit suite green (includes `oauth-google.test.ts` + `google-user.test.ts`).
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run build` — clean; `/api/auth/google/start`, `/api/auth/google/callback`, `/api/auth/vault/{status,init,unlock}` in the route list.
- [ ] `npx vitest run --config vitest.e2e.config.ts` (with `npm run dev` running) — green.
- [ ] Manual smoke (optional, needs real Google creds): set real `GOOGLE_CLIENT_ID`/`SECRET`, click "Continue with Google" → consent → set passphrase → vault; sign out, sign in with Google → enter passphrase → vault.
- [ ] Update `MEMORY.md` / project-state: Google Sign-In slice done; linking still deferred.
```

