# Google Account-Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an existing email + passphrase account attach (and detach) a Google identity, so "Continue with Google" reaches the same vault — from a settings page and inline when a Google login collides with an existing email.

**Architecture:** Identity-only. The master key still derives from the vault passphrase; linking only sets `User.googleId` (already exists — no migration). Both link paths converge on: obtain a Google-verified identity → server sets an HMAC-signed, httpOnly, short-TTL **pending-link cookie** → a confirm step re-auths with the passphrase (`authVerifier`, bcrypt-verified) → attach `googleId`. Unlink re-auths the same way and refuses if the account has no password login.

**Tech Stack:** Next.js 16 App Router (`Request`/`NextResponse`), Prisma 6, bcryptjs, `node:crypto` HMAC, WebCrypto (client key derivation), Vitest.

## Global Constraints

- **Zero-knowledge invariant:** only `authVerifier` (never the passphrase or master key) may reach the server. Linking never touches ciphertext, IVs, or key material. (`AGENTS.md`)
- **No new migration:** `User.googleId` is `String? @unique` and already exists.
- **New server-only env var `LINK_STATE_SECRET`** signs the pending-link cookie. Routes that sign/verify it **fail closed (500)** when it is unset, mirroring `SURVIVOR_SALT_SECRET`.
- **Pending-link cookie:** name `legacy_pending_link`; `httpOnly`, `secure` in production, `sameSite: "lax"`, `path: "/"`, TTL 5 minutes; HMAC-SHA256 signed.
- **Generic denial:** wrong/absent passphrase at `/link` and `/unlink` returns HTTP 401 with body `{ error: "That passphrase didn't match." }`. Run exactly one bcrypt compare per request (real hash or `DECOY_VERIFIER_HASH`) for timing parity.
- **Copy** follows the calm brand voice already used on `/unlock` (plain, reassuring, lowercase-first sentences).
- **TypeScript strict.** Always run `npx tsc --noEmit` before committing a task. Unit tests: `npm test`.
- Conventional-commit messages; commit at the end of every task.

---

### Task 1: Pending-link cookie signer (`src/lib/link-token.ts`)

Pure module that serializes + HMAC-signs a `{ googleId, email }` identity into an opaque cookie value with a 5-minute expiry, and verifies/parses it back (rejecting tampered, malformed, or expired values). Also owns the cookie name, cookie options, and the secret reader.

**Files:**
- Create: `src/lib/link-token.ts`
- Test: `src/lib/link-token.test.ts`

**Interfaces:**
- Produces:
  - `PENDING_LINK_COOKIE: "legacy_pending_link"`
  - `PENDING_LINK_TTL_MS: number` (300000)
  - `interface PendingLink { googleId: string; email: string }`
  - `signPendingLink(link: PendingLink, secret: string, nowMs?: number): string`
  - `verifyPendingLink(value: string | undefined, secret: string, nowMs?: number): PendingLink | null`
  - `pendingLinkCookieOptions(): { httpOnly: true; secure: boolean; sameSite: "lax"; path: "/"; maxAge: number }`
  - `linkStateSecret(): string` (reads `process.env.LINK_STATE_SECRET ?? ""`)

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/link-token.test.ts
import { describe, it, expect } from "vitest";
import {
  signPendingLink,
  verifyPendingLink,
  PENDING_LINK_TTL_MS,
} from "./link-token";

const secret = "unit-secret";
const link = { googleId: "google-123", email: "a@example.com" };

describe("link-token", () => {
  it("round-trips a signed pending-link value", () => {
    const value = signPendingLink(link, secret, 1000);
    expect(verifyPendingLink(value, secret, 1000)).toEqual(link);
  });

  it("rejects a value signed with a different secret", () => {
    const value = signPendingLink(link, secret, 1000);
    expect(verifyPendingLink(value, "other-secret", 1000)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const value = signPendingLink(link, secret, 1000);
    const tampered = "x" + value.slice(1);
    expect(verifyPendingLink(tampered, secret, 1000)).toBeNull();
  });

  it("rejects an expired value", () => {
    const value = signPendingLink(link, secret, 1000);
    expect(verifyPendingLink(value, secret, 1000 + PENDING_LINK_TTL_MS + 1)).toBeNull();
  });

  it("rejects undefined / malformed values", () => {
    expect(verifyPendingLink(undefined, secret, 1000)).toBeNull();
    expect(verifyPendingLink("not-a-token", secret, 1000)).toBeNull();
    expect(verifyPendingLink("nodot", secret, 1000)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/link-token.test.ts`
Expected: FAIL — cannot resolve `./link-token`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/link-token.ts
import { createHmac, timingSafeEqual } from "crypto";

export const PENDING_LINK_COOKIE = "legacy_pending_link";
export const PENDING_LINK_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface PendingLink {
  googleId: string;
  email: string;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Serialize + HMAC-sign a pending-link identity into an opaque cookie value.
 * Format: `base64url(JSON{ googleId, email, exp }).signature`.
 */
export function signPendingLink(
  link: PendingLink,
  secret: string,
  nowMs: number = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({ googleId: link.googleId, email: link.email, exp: nowMs + PENDING_LINK_TTL_MS }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Verify a pending-link cookie value. Returns the identity when the signature
 * is valid and unexpired, else null (tampered, malformed, expired, or absent).
 */
export function verifyPendingLink(
  value: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): PendingLink | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);

  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (typeof decoded !== "object" || decoded === null) return null;
    const { googleId, email, exp } = decoded as Record<string, unknown>;
    if (typeof googleId !== "string" || typeof email !== "string" || typeof exp !== "number") {
      return null;
    }
    if (exp < nowMs) return null;
    return { googleId, email };
  } catch {
    return null;
  }
}

export function pendingLinkCookieOptions() {
  return {
    httpOnly: true as const,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/" as const,
    maxAge: Math.floor(PENDING_LINK_TTL_MS / 1000),
  };
}

export function linkStateSecret(): string {
  return process.env.LINK_STATE_SECRET ?? "";
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/lib/link-token.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/link-token.ts src/lib/link-token.test.ts
git commit -m "feat(auth): HMAC-signed pending-link cookie token lib"
```

---

### Task 2: Account status route (`GET /api/account/status`)

Session-scoped read that drives the account page.

**Files:**
- Create: `src/app/api/account/status/route.ts`
- Test: `src/app/api/account/status/route.test.ts`

**Interfaces:**
- Consumes: `requireUserId` (`@/lib/route-auth`), `prisma` (`@/lib/db`).
- Produces: `GET(): Response` → `{ email: string; googleLinked: boolean; hasPassword: boolean }` (200) or `{ error }` (401).

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/account/status/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUserId = vi.fn();
const findUnique = vi.fn();
vi.mock("@/lib/route-auth", () => ({ requireUserId: () => requireUserId() }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a) } } }));

import { GET } from "./route";

beforeEach(() => {
  requireUserId.mockReset();
  findUnique.mockReset();
});

describe("GET /api/account/status", () => {
  it("401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("reports linked + hasPassword flags", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ email: "a@example.com", googleId: "g1", authVerifierHash: "$2..." });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "a@example.com", googleLinked: true, hasPassword: true });
  });

  it("reports not-linked + no-password when nulls", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ email: "a@example.com", googleId: null, authVerifierHash: null });
    const res = await GET();
    expect(await res.json()).toEqual({ email: "a@example.com", googleLinked: false, hasPassword: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/account/status/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/api/account/status/route.ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/route-auth";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, googleId: true, authVerifierHash: true },
  });
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  return NextResponse.json({
    email: user.email,
    googleLinked: user.googleId != null,
    hasPassword: user.authVerifierHash != null,
  });
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/app/api/account/status/route.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/account/status/route.ts src/app/api/account/status/route.test.ts
git commit -m "feat(account): GET /api/account/status (email, googleLinked, hasPassword)"
```

---

### Task 3: `google/start` link intent

Extend the existing start route to record `?intent=link` in a short-lived cookie the callback reads.

**Files:**
- Modify: `src/app/api/auth/google/start/route.ts`
- Test: `src/app/api/auth/google/start/route.test.ts`

**Interfaces:**
- Produces: `GET(req: Request): Response` — 302 to Google; sets cookies `google_oauth_state`, `google_code_verifier`, and `google_oauth_intent` (`"link"` when `?intent=link`, else `"login"`).

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/auth/google/start/route.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("arctic", () => ({
  generateState: () => "state-x",
  generateCodeVerifier: () => "verifier-x",
}));
vi.mock("@/lib/oauth-google", () => ({
  createGoogleAuthUrl: () => new URL("https://accounts.google.com/o/oauth2/v2/auth"),
}));

import { GET } from "./route";

function cookieValue(res: Response, name: string): string | undefined {
  const all = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  const hit = all.find((c) => c.startsWith(`${name}=`));
  return hit?.split(";")[0].split("=")[1];
}

describe("GET /api/auth/google/start", () => {
  it("records intent=login by default", async () => {
    const res = await GET(new Request("http://localhost/api/auth/google/start"));
    expect(cookieValue(res, "google_oauth_intent")).toBe("login");
  });

  it("records intent=link when ?intent=link", async () => {
    const res = await GET(new Request("http://localhost/api/auth/google/start?intent=link"));
    expect(cookieValue(res, "google_oauth_intent")).toBe("link");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/auth/google/start/route.test.ts`
Expected: FAIL — `GET` currently takes no args / sets no intent cookie.

- [ ] **Step 3: Write minimal implementation** — replace the file:

```ts
// src/app/api/auth/google/start/route.ts
import { NextResponse } from "next/server";
import { generateState, generateCodeVerifier } from "arctic";
import { createGoogleAuthUrl } from "@/lib/oauth-google";

const TEN_MINUTES = 600;

export async function GET(req: Request) {
  const intent = new URL(req.url).searchParams.get("intent") === "link" ? "link" : "login";

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
  res.cookies.set("google_oauth_intent", intent, opts);
  return res;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/app/api/auth/google/start/route.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/google/start/route.ts src/app/api/auth/google/start/route.test.ts
git commit -m "feat(auth): google/start records link vs login intent"
```

---

### Task 4: `google/callback` link + collision branching

After identity verification, branch: explicit `intent=link` and login-collision both set the pending-link cookie and redirect to a confirm view; plain new/known Google login is unchanged.

**Files:**
- Modify: `src/app/api/auth/google/callback/route.ts`
- Test: `src/app/api/auth/google/callback/route.test.ts`

**Interfaces:**
- Consumes: `resolveGoogleIdentity` (`@/lib/oauth-google`), `findOrCreateGoogleUser` (`@/lib/google-user`), `createSession` (`@/lib/auth`), `signPendingLink`/`pendingLinkCookieOptions`/`linkStateSecret`/`PENDING_LINK_COOKIE` (`@/lib/link-token`), `cookies` (`next/headers`).
- Produces: `GET(req: Request): Response` — redirects to `/account?link=confirm` (link intent), `/unlock?link=confirm` (login collision, cookie set), `/unlock` (login success, session set), or `/unlock?error=...` on failure.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/auth/google/callback/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const cookieStore = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => {
      const v = cookieStore.get(n);
      return v === undefined ? undefined : { value: v };
    },
  }),
}));

const resolveGoogleIdentity = vi.fn();
vi.mock("@/lib/oauth-google", () => ({ resolveGoogleIdentity: (...a: unknown[]) => resolveGoogleIdentity(...a) }));

const findOrCreateGoogleUser = vi.fn();
vi.mock("@/lib/google-user", () => ({ findOrCreateGoogleUser: (...a: unknown[]) => findOrCreateGoogleUser(...a) }));

vi.mock("@/lib/auth", () => ({ createSession: async () => "sess-1" }));

process.env.LINK_STATE_SECRET = "callback-secret";
process.env.APP_BASE_URL = "http://localhost:3000";

import { GET } from "./route";
import { verifyPendingLink, PENDING_LINK_COOKIE } from "@/lib/link-token";

function setCookies(entries: Record<string, string>) {
  cookieStore.clear();
  for (const [k, v] of Object.entries(entries)) cookieStore.set(k, v);
}
function req() {
  return new Request("http://localhost/api/auth/google/callback?code=abc&state=s");
}
function setCookie(res: Response, name: string): string | undefined {
  const all = res.headers.getSetCookie?.() ?? [];
  return all.find((c) => c.startsWith(`${name}=`))?.split(";")[0].split("=")[1];
}

beforeEach(() => {
  resolveGoogleIdentity.mockReset();
  findOrCreateGoogleUser.mockReset();
});

describe("GET /api/auth/google/callback", () => {
  const identity = { googleId: "g-1", email: "a@example.com", emailVerified: true };

  it("login: new/known Google user gets a session and lands on /unlock", async () => {
    setCookies({ google_oauth_state: "s", google_code_verifier: "v", google_oauth_intent: "login" });
    resolveGoogleIdentity.mockResolvedValue(identity);
    findOrCreateGoogleUser.mockResolvedValue({ ok: true, userId: "u1" });
    const res = await GET(req());
    expect(res.headers.get("location")).toBe("http://localhost:3000/unlock");
    expect(setCookie(res, "legacy_session")).toBe("sess-1");
  });

  it("login collision: sets a valid pending-link cookie and redirects to confirm", async () => {
    setCookies({ google_oauth_state: "s", google_code_verifier: "v", google_oauth_intent: "login" });
    resolveGoogleIdentity.mockResolvedValue(identity);
    findOrCreateGoogleUser.mockResolvedValue({ ok: false, reason: "email_taken" });
    const res = await GET(req());
    expect(res.headers.get("location")).toBe("http://localhost:3000/unlock?link=confirm");
    const cookie = setCookie(res, PENDING_LINK_COOKIE);
    expect(verifyPendingLink(cookie, "callback-secret")).toEqual({ googleId: "g-1", email: "a@example.com" });
  });

  it("link intent: sets pending-link cookie and redirects to /account confirm (no find-or-create)", async () => {
    setCookies({ google_oauth_state: "s", google_code_verifier: "v", google_oauth_intent: "link" });
    resolveGoogleIdentity.mockResolvedValue(identity);
    const res = await GET(req());
    expect(res.headers.get("location")).toBe("http://localhost:3000/account?link=confirm");
    expect(findOrCreateGoogleUser).not.toHaveBeenCalled();
    expect(verifyPendingLink(setCookie(res, PENDING_LINK_COOKIE), "callback-secret")).toEqual({
      googleId: "g-1",
      email: "a@example.com",
    });
  });

  it("refuses an unverified Google email", async () => {
    setCookies({ google_oauth_state: "s", google_code_verifier: "v", google_oauth_intent: "login" });
    resolveGoogleIdentity.mockResolvedValue({ ...identity, emailVerified: false });
    const res = await GET(req());
    expect(res.headers.get("location")).toBe("http://localhost:3000/unlock?error=google_unverified");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/auth/google/callback/route.test.ts`
Expected: FAIL — collision path currently redirects to `?error=email_exists`; no link branch.

- [ ] **Step 3: Write minimal implementation** — replace the file:

```ts
// src/app/api/auth/google/callback/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { resolveGoogleIdentity } from "@/lib/oauth-google";
import { findOrCreateGoogleUser } from "@/lib/google-user";
import { createSession } from "@/lib/auth";
import { SESSION_COOKIE, sessionCookieOptions, sessionExpiry } from "@/lib/session-cookie";
import {
  PENDING_LINK_COOKIE,
  pendingLinkCookieOptions,
  signPendingLink,
  linkStateSecret,
} from "@/lib/link-token";

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
  const intent = jar.get("google_oauth_intent")?.value === "link" ? "link" : "login";

  const clearOauth = (res: NextResponse) => {
    res.cookies.delete("google_oauth_state");
    res.cookies.delete("google_code_verifier");
    res.cookies.delete("google_oauth_intent");
    return res;
  };
  const fail = (reason: string) =>
    clearOauth(NextResponse.redirect(new URL(`/unlock?error=${reason}`, appBaseUrl())));

  // Set the pending-link cookie and send the user to `path` to confirm with their passphrase.
  const toConfirm = (path: string, googleId: string, email: string) => {
    const secret = linkStateSecret();
    if (!secret) return fail("server_misconfig");
    const res = clearOauth(NextResponse.redirect(new URL(path, appBaseUrl())));
    res.cookies.set(PENDING_LINK_COOKIE, signPendingLink({ googleId, email }, secret), pendingLinkCookieOptions());
    return res;
  };

  if (!code || !state || !storedState || !codeVerifier || state !== storedState) {
    return fail("google_failed");
  }

  try {
    const identity = await resolveGoogleIdentity(code, codeVerifier);
    if (!identity.emailVerified) return fail("google_unverified");

    // Explicit link intent from the account page — never auto-links.
    if (intent === "link") {
      return toConfirm("/account?link=confirm", identity.googleId, identity.email);
    }

    const result = await findOrCreateGoogleUser(identity);
    if (!result.ok) {
      // Email collides with an existing password account: offer inline linking.
      return toConfirm("/unlock?link=confirm", identity.googleId, identity.email);
    }

    const sessionId = await createSession(result.userId);
    const res = clearOauth(NextResponse.redirect(new URL("/unlock", appBaseUrl())));
    res.cookies.set(SESSION_COOKIE, sessionId, sessionCookieOptions(sessionExpiry()));
    return res;
  } catch {
    return fail("google_failed");
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/app/api/auth/google/callback/route.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/google/callback/route.ts src/app/api/auth/google/callback/route.test.ts
git commit -m "feat(auth): callback branches link intent + login collision to passphrase confirm"
```

---

### Task 5: Pending-link display route (`GET /api/auth/google/pending`)

Lets the not-logged-in collision-confirm view show which Google email is being linked, without reading the httpOnly cookie from JS.

**Files:**
- Create: `src/app/api/auth/google/pending/route.ts`
- Test: `src/app/api/auth/google/pending/route.test.ts`

**Interfaces:**
- Consumes: `cookies` (`next/headers`), `verifyPendingLink`/`PENDING_LINK_COOKIE`/`linkStateSecret` (`@/lib/link-token`).
- Produces: `GET(): Response` → `{ email: string | null }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/auth/google/pending/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

let cookieVal: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (_: string) => (cookieVal === undefined ? undefined : { value: cookieVal }) }),
}));

process.env.LINK_STATE_SECRET = "pending-secret";
import { GET } from "./route";
import { signPendingLink } from "@/lib/link-token";

beforeEach(() => {
  cookieVal = undefined;
});

describe("GET /api/auth/google/pending", () => {
  it("returns null when no cookie", async () => {
    expect(await (await GET()).json()).toEqual({ email: null });
  });

  it("returns the email from a valid cookie", async () => {
    cookieVal = signPendingLink({ googleId: "g1", email: "a@example.com" }, "pending-secret");
    expect(await (await GET()).json()).toEqual({ email: "a@example.com" });
  });

  it("returns null for a tampered cookie", async () => {
    cookieVal = "garbage.value";
    expect(await (await GET()).json()).toEqual({ email: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/auth/google/pending/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/api/auth/google/pending/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { PENDING_LINK_COOKIE, verifyPendingLink, linkStateSecret } from "@/lib/link-token";

export async function GET() {
  const secret = linkStateSecret();
  const jar = await cookies();
  const pending = secret ? verifyPendingLink(jar.get(PENDING_LINK_COOKIE)?.value, secret) : null;
  return NextResponse.json({ email: pending?.email ?? null });
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/app/api/auth/google/pending/route.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/google/pending/route.ts src/app/api/auth/google/pending/route.test.ts
git commit -m "feat(auth): GET /api/auth/google/pending (display email for collision confirm)"
```

---

### Task 6: Link route (`POST /api/auth/google/link`)

Re-auths with the passphrase and attaches the pending `googleId` to the resolved account. Target resolved server-side (session if logged in, else the cookie's email). Never client-supplied.

**Files:**
- Create: `src/app/api/auth/google/link/route.ts`
- Test: `src/app/api/auth/google/link/route.test.ts`

**Interfaces:**
- Consumes: `readJsonBody` (`@/lib/http`), `verifyVerifier`/`createSession`/`DECOY_VERIFIER_HASH` (`@/lib/auth`), `requireUserId` (`@/lib/route-auth`), `SESSION_COOKIE`/`sessionCookieOptions`/`sessionExpiry` (`@/lib/session-cookie`), `PENDING_LINK_COOKIE`/`verifyPendingLink`/`linkStateSecret` (`@/lib/link-token`), `cookies` (`next/headers`), `prisma`.
- Produces: `POST(req: Request): Response` — body `{ authVerifier }`; `{ ok: true }` (200, sets session cookie if none), or `{ error }` with 400 (no/expired cookie), 401 (passphrase), 409 (already linked / googleId taken), 500 (no secret).

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/auth/google/link/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

let cookieVal: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (_: string) => (cookieVal === undefined ? undefined : { value: cookieVal }) }),
}));

const requireUserId = vi.fn();
vi.mock("@/lib/route-auth", () => ({ requireUserId: () => requireUserId() }));

const findUnique = vi.fn();
const update = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a), update: (...a: unknown[]) => update(...a) } },
}));

vi.mock("@/lib/auth", () => ({
  verifyVerifier: async (v: string, h: string) => h === `hash:${v}`,
  createSession: async () => "sess-new",
  DECOY_VERIFIER_HASH: "hash:__decoy__",
}));

process.env.LINK_STATE_SECRET = "link-secret";
import { POST } from "./route";
import { signPendingLink, PENDING_LINK_COOKIE } from "@/lib/link-token";

function req(body: unknown) {
  return new Request("http://localhost/api/auth/google/link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function setCookie(res: Response, name: string): string | undefined {
  return (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith(`${name}=`))?.split(";")[0].split("=")[1];
}
const validCookie = () => signPendingLink({ googleId: "g-new", email: "a@example.com" }, "link-secret");

beforeEach(() => {
  cookieVal = undefined;
  requireUserId.mockReset();
  findUnique.mockReset();
  update.mockReset();
});

describe("POST /api/auth/google/link", () => {
  it("400 when the pending-link cookie is missing", async () => {
    requireUserId.mockResolvedValue("u1");
    const res = await POST(req({ authVerifier: "v" }));
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("collision path: resolves by cookie email, verifies passphrase, links, creates session", async () => {
    cookieVal = validCookie();
    requireUserId.mockResolvedValue(null); // not logged in
    findUnique.mockResolvedValue({ id: "u1", email: "a@example.com", authVerifierHash: "hash:v", googleId: null });
    update.mockResolvedValue({});
    const res = await POST(req({ authVerifier: "v" }));
    expect(res.status).toBe(200);
    expect(findUnique).toHaveBeenCalledWith({ where: { email: "a@example.com" } });
    expect(update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { googleId: "g-new" } });
    expect(setCookie(res, PENDING_LINK_COOKIE)).toBe(""); // cleared
    expect(setCookie(res, "legacy_session")).toBe("sess-new");
  });

  it("settings path: resolves by session, no new session cookie", async () => {
    cookieVal = validCookie();
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ id: "u1", email: "a@example.com", authVerifierHash: "hash:v", googleId: null });
    update.mockResolvedValue({});
    const res = await POST(req({ authVerifier: "v" }));
    expect(res.status).toBe(200);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "u1" } });
    expect(setCookie(res, "legacy_session")).toBeUndefined();
  });

  it("401 on wrong passphrase", async () => {
    cookieVal = validCookie();
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ id: "u1", email: "a@example.com", authVerifierHash: "hash:right", googleId: null });
    const res = await POST(req({ authVerifier: "wrong" }));
    expect(res.status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it("401 when the target account has no password login", async () => {
    cookieVal = validCookie();
    requireUserId.mockResolvedValue(null);
    findUnique.mockResolvedValue({ id: "u1", email: "a@example.com", authVerifierHash: null, googleId: null });
    expect((await POST(req({ authVerifier: "v" }))).status).toBe(401);
  });

  it("409 when the account already has Google linked", async () => {
    cookieVal = validCookie();
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ id: "u1", email: "a@example.com", authVerifierHash: "hash:v", googleId: "g-old" });
    const res = await POST(req({ authVerifier: "v" }));
    expect(res.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it("409 when the googleId is already linked elsewhere (unique violation)", async () => {
    cookieVal = validCookie();
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ id: "u1", email: "a@example.com", authVerifierHash: "hash:v", googleId: null });
    update.mockRejectedValue(new Error("Unique constraint failed"));
    expect((await POST(req({ authVerifier: "v" }))).status).toBe(409);
  });

  it("500 when LINK_STATE_SECRET is unset", async () => {
    const saved = process.env.LINK_STATE_SECRET;
    delete process.env.LINK_STATE_SECRET;
    try {
      expect((await POST(req({ authVerifier: "v" }))).status).toBe(500);
    } finally {
      process.env.LINK_STATE_SECRET = saved;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/auth/google/link/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/api/auth/google/link/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { verifyVerifier, createSession, DECOY_VERIFIER_HASH } from "@/lib/auth";
import { requireUserId } from "@/lib/route-auth";
import { SESSION_COOKIE, sessionCookieOptions, sessionExpiry } from "@/lib/session-cookie";
import { readJsonBody } from "@/lib/http";
import { PENDING_LINK_COOKIE, verifyPendingLink, linkStateSecret } from "@/lib/link-token";

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const authVerifier = typeof body.authVerifier === "string" ? body.authVerifier : "";

  const secret = linkStateSecret();
  if (!secret) return NextResponse.json({ error: "Server misconfiguration." }, { status: 500 });

  const jar = await cookies();
  const pending = verifyPendingLink(jar.get(PENDING_LINK_COOKIE)?.value, secret);
  if (!pending) {
    return NextResponse.json({ error: "Your linking session expired. Please start again." }, { status: 400 });
  }

  // Resolve the target account server-side — never from the request body.
  const sessionUserId = await requireUserId();
  const user = sessionUserId
    ? await prisma.user.findUnique({ where: { id: sessionUserId } })
    : await prisma.user.findUnique({ where: { email: pending.email.trim().toLowerCase() } });

  const generic = NextResponse.json({ error: "That passphrase didn't match." }, { status: 401 });

  // One bcrypt compare regardless of path (timing parity); decoy when no real hash.
  const ok = await verifyVerifier(authVerifier, user?.authVerifierHash ?? DECOY_VERIFIER_HASH);
  if (!user || !user.authVerifierHash || !ok) return generic;

  if (user.googleId) {
    return NextResponse.json({ error: "This account already has Google linked." }, { status: 409 });
  }

  try {
    await prisma.user.update({ where: { id: user.id }, data: { googleId: pending.googleId } });
  } catch {
    return NextResponse.json(
      { error: "That Google account is already linked to another account." },
      { status: 409 },
    );
  }

  const res = NextResponse.json({ ok: true });
  if (!sessionUserId) {
    const sid = await createSession(user.id);
    res.cookies.set(SESSION_COOKIE, sid, sessionCookieOptions(sessionExpiry()));
  }
  res.cookies.delete(PENDING_LINK_COOKIE);
  return res;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/app/api/auth/google/link/route.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/google/link/route.ts src/app/api/auth/google/link/route.test.ts
git commit -m "feat(auth): POST /api/auth/google/link (passphrase re-auth + attach googleId)"
```

---

### Task 7: Unlink route (`POST /api/auth/google/unlink`)

Session-scoped. Re-auths, refuses if the account has no password login (would strand the user), else clears `googleId`.

**Files:**
- Create: `src/app/api/auth/google/unlink/route.ts`
- Test: `src/app/api/auth/google/unlink/route.test.ts`

**Interfaces:**
- Consumes: `readJsonBody` (`@/lib/http`), `verifyVerifier` (`@/lib/auth`), `requireUserId` (`@/lib/route-auth`), `prisma`.
- Produces: `POST(req: Request): Response` — body `{ authVerifier }`; `{ ok: true }` (200), or 401 (unauth / wrong passphrase), 409 (no password login).

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/auth/google/unlink/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUserId = vi.fn();
const findUnique = vi.fn();
const update = vi.fn();
vi.mock("@/lib/route-auth", () => ({ requireUserId: () => requireUserId() }));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a), update: (...a: unknown[]) => update(...a) } },
}));
vi.mock("@/lib/auth", () => ({ verifyVerifier: async (v: string, h: string) => h === `hash:${v}` }));

import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://localhost/api/auth/google/unlink", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  requireUserId.mockReset();
  findUnique.mockReset();
  update.mockReset();
});

describe("POST /api/auth/google/unlink", () => {
  it("401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await POST(req({ authVerifier: "v" }))).status).toBe(401);
  });

  it("clears googleId on correct passphrase", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ id: "u1", authVerifierHash: "hash:v", googleId: "g1" });
    update.mockResolvedValue({});
    const res = await POST(req({ authVerifier: "v" }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { googleId: null } });
  });

  it("401 on wrong passphrase", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ id: "u1", authVerifierHash: "hash:right", googleId: "g1" });
    expect((await POST(req({ authVerifier: "wrong" }))).status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it("409 when the account has no password login", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ id: "u1", authVerifierHash: null, googleId: "g1" });
    expect((await POST(req({ authVerifier: "v" }))).status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/auth/google/unlink/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/api/auth/google/unlink/route.ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyVerifier } from "@/lib/auth";
import { requireUserId } from "@/lib/route-auth";
import { readJsonBody } from "@/lib/http";

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const authVerifier = typeof body.authVerifier === "string" ? body.authVerifier : "";

  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  const generic = NextResponse.json({ error: "That passphrase didn't match." }, { status: 401 });
  if (!user) return generic;
  if (!user.authVerifierHash) {
    return NextResponse.json({ error: "Set a vault passphrase before unlinking Google." }, { status: 409 });
  }
  if (!(await verifyVerifier(authVerifier, user.authVerifierHash))) return generic;

  await prisma.user.update({ where: { id: user.id }, data: { googleId: null } });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/app/api/auth/google/unlink/route.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/google/unlink/route.ts src/app/api/auth/google/unlink/route.test.ts
git commit -m "feat(auth): POST /api/auth/google/unlink (re-auth + clear googleId, no-password guard)"
```

---

### Task 8: API-client methods

Add the four fetch wrappers the pages consume. The gate for this task is `tsc` (methods are exercised by Tasks 9–10 and the e2e).

**Files:**
- Modify: `src/lib/api-client.ts` (add to the `api` object, after `vaultUnlock`)

**Interfaces:**
- Produces on `api`:
  - `accountStatus(): Promise<{ email: string; googleLinked: boolean; hasPassword: boolean } | null>` (null on 401)
  - `pendingLink(): Promise<{ email: string | null }>`
  - `googleLink(authVerifier: string): Promise<{ ok: true }>`
  - `googleUnlink(authVerifier: string): Promise<{ ok: true }>`

- [ ] **Step 1: Add the methods** — insert after the `vaultUnlock` entry:

```ts
  accountStatus: async () => {
    const res = await fetch("/api/account/status");
    if (res.status === 401) return null;
    if (!res.ok) throw new Error("We couldn't load your account.");
    return res.json() as Promise<{ email: string; googleLinked: boolean; hasPassword: boolean }>;
  },
  pendingLink: async () => {
    const res = await fetch("/api/auth/google/pending");
    if (!res.ok) return { email: null as string | null };
    return res.json() as Promise<{ email: string | null }>;
  },
  googleLink: (authVerifier: string) =>
    post<{ ok: true }>("/api/auth/google/link", { authVerifier }),
  googleUnlink: (authVerifier: string) =>
    post<{ ok: true }>("/api/auth/google/unlink", { authVerifier }),
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api-client.ts
git commit -m "feat(account): api-client methods for status, pending, link, unlink"
```

---

### Task 9: Account page (`/account`) + nav link

Session-gated page showing account email + link state, with link/unlink (passphrase re-auth) and the `?link=confirm` panel after returning from Google.

**Files:**
- Create: `src/app/account/page.tsx`
- Modify: `src/components/AppNav.tsx` (add an `/account` link)

**Interfaces:**
- Consumes: `api.accountStatus`, `api.pendingLink`, `api.googleLink`, `api.googleUnlink`, `api.vaultStatus` (for the kdf salt), `deriveMasterKey`/`deriveAuthVerifier` (`@/lib/crypto`).

- [ ] **Step 1: Create the page**

```tsx
// src/app/account/page.tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { BrandHeader } from "@/components/Logo";
import { deriveMasterKey, deriveAuthVerifier } from "@/lib/crypto";

type Status = { email: string; googleLinked: boolean; hasPassword: boolean };

// Re-derive the authVerifier from the passphrase (re-auth). Needs the account's
// kdf salt, which vaultStatus returns for the logged-in user.
async function deriveVerifier(passphrase: string): Promise<string> {
  const status = await api.vaultStatus();
  const salt = status?.salt;
  if (!salt) throw new Error("Set your vault passphrase first.");
  const masterKey = await deriveMasterKey(passphrase, salt);
  return deriveAuthVerifier(masterKey, passphrase);
}

export default function AccountPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmEmail, setConfirmEmail] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [mode, setMode] = useState<"idle" | "confirm-link" | "unlink">("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const s = await api.accountStatus();
    if (s === null) {
      router.push("/unlock");
      return;
    }
    setStatus(s);
    setLoading(false);
  }

  useEffect(() => {
    const confirming = new URLSearchParams(window.location.search).get("link") === "confirm";
    (async () => {
      await refresh();
      if (confirming) {
        const { email } = await api.pendingLink();
        if (email) {
          setConfirmEmail(email);
          setMode("confirm-link");
        }
      }
    })().catch(() => router.push("/unlock"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onConfirmLink(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const authVerifier = await deriveVerifier(passphrase);
      await api.googleLink(authVerifier);
      setNotice("Google is now linked to your account.");
      setMode("idle");
      setPassphrase("");
      window.history.replaceState(null, "", "/account");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't link Google.");
    } finally {
      setBusy(false);
    }
  }

  async function onUnlink(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const authVerifier = await deriveVerifier(passphrase);
      await api.googleUnlink(authVerifier);
      setNotice("Google has been unlinked.");
      setMode("idle");
      setPassphrase("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't unlink Google.");
    } finally {
      setBusy(false);
    }
  }

  if (loading || !status) {
    return (
      <main className="center">
        <div className="card">
          <BrandHeader />
          <p className="subtle">Loading…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="center">
      <div className="card">
        <BrandHeader />
        <h1>Your account</h1>
        <p className="subtle">Signed in as {status.email}.</p>

        {mode === "confirm-link" && confirmEmail && (
          <form onSubmit={onConfirmLink}>
            <p>
              Link Google account <strong>{confirmEmail}</strong>? Enter your vault passphrase to
              confirm.
            </p>
            <label htmlFor="pp">Vault passphrase</label>
            <input id="pp" type="password" value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)} required />
            <button type="submit" disabled={busy}>{busy ? "Linking…" : "Confirm link"}</button>
          </form>
        )}

        {mode === "unlink" && (
          <form onSubmit={onUnlink}>
            <p>Unlink Google? Enter your vault passphrase to confirm.</p>
            <label htmlFor="pu">Vault passphrase</label>
            <input id="pu" type="password" value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)} required />
            <button type="submit" disabled={busy}>{busy ? "Unlinking…" : "Confirm unlink"}</button>
          </form>
        )}

        {mode === "idle" && (
          <div>
            <p className="subtle">
              Google sign-in: <strong>{status.googleLinked ? "Linked" : "Not linked"}</strong>
            </p>
            {!status.googleLinked && (
              <a className="linkbtn" href="/api/auth/google/start?intent=link">Link Google</a>
            )}
            {status.googleLinked && status.hasPassword && (
              <button type="button" onClick={() => { setNotice(""); setError(""); setMode("unlink"); }}>
                Unlink Google
              </button>
            )}
          </div>
        )}

        {notice && <p className="subtle">{notice}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Add the nav link** — in `src/components/AppNav.tsx`, add an Account link at the end of the `<div className="navlinks">` block, right after the `/assistant` link:

```tsx
        <Link href="/assistant">Assistant</Link>
        <Link href="/account">Account</Link>
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean; `/account` appears in the route list.

- [ ] **Step 4: Commit**

```bash
git add src/app/account/page.tsx src/components/AppNav.tsx
git commit -m "feat(account): /account page (link/unlink Google with passphrase re-auth) + nav"
```

---

### Task 10: `/unlock` collision-confirm view

When the callback redirects to `/unlock?link=confirm`, show an inline "enter your passphrase to link Google" panel that, on success, links + unlocks the vault in a single passphrase entry.

**Files:**
- Modify: `src/app/unlock/page.tsx`

**Interfaces:**
- Consumes: `api.pendingLink`, `api.getSalt`, `api.googleLink`, `deriveMasterKey`/`deriveAuthVerifier`, `useKey().setMasterKey`.

- [ ] **Step 1: Update the copy for the collision error** — replace the `email_exists` entry in the `ERRORS` map:

```tsx
  email_exists:
    "An account with that email already exists. Sign in with your passphrase below.",
```

- [ ] **Step 2: Add a `link` mode + confirm handler.** Extend the `Mode` union and the initial effect, and add a handler + render branch.

Change the type:

```tsx
type Mode = "loading" | "email" | "create" | "enter" | "link";
```

Add link-confirm state near the other `useState` hooks:

```tsx
  const [linkEmail, setLinkEmail] = useState("");
```

In the mount `useEffect`, before the `api.vaultStatus()` call, branch on `?link=confirm`:

```tsx
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("error");
    if (q && ERRORS[q]) setError(ERRORS[q]);

    if (params.get("link") === "confirm") {
      api
        .pendingLink()
        .then(({ email }) => {
          if (email) {
            setLinkEmail(email);
            setMode("link");
          } else {
            setMode("email");
          }
        })
        .catch(() => setMode("email"));
      return;
    }

    api
      .vaultStatus()
      .then((status) => {
        if (status === null) setMode("email");
        else if (status.initialized) { setSalt(status.salt ?? ""); setMode("enter"); }
        else setMode("create");
      })
      .catch(() => setMode("email"));
  }, []);
```

Add the confirm-link handler (near the other `onSubmit` handlers). It derives from the single passphrase entry: the `authVerifier` for the link call **and** the master key for the vault, so the user lands unlocked:

```tsx
  async function onLinkSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { salt: s } = await api.getSalt(linkEmail).catch(() => {
        throw new Error("That passphrase didn't match.");
      });
      const masterKey = await deriveMasterKey(passphrase, s);
      const authVerifier = await deriveAuthVerifier(masterKey, passphrase);
      await api.googleLink(authVerifier).catch(() => {
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
```

Add the render branch (place it before the final `mode === "email"` return):

```tsx
  if (mode === "link") {
    return (
      <main className="center">
        <form className="card" onSubmit={onLinkSubmit}>
          <BrandHeader />
          <h1>Link Google to your account</h1>
          <p className="subtle">
            This email already has a Legacy account. Enter your vault passphrase to link Google
            and unlock your vault.
          </p>
          <label htmlFor="pass">Passphrase</label>
          <input id="pass" type="password" value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)} required />
          <button type="submit" disabled={busy}>{busy ? "Linking…" : "Link & unlock"}</button>
          {error && <p className="error">{error}</p>}
        </form>
      </main>
    );
  }
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/app/unlock/page.tsx
git commit -m "feat(auth): /unlock collision-confirm links Google + unlocks in one passphrase entry"
```

---

### Task 11: Env var + live e2e round-trip

Add `LINK_STATE_SECRET` to the env files and extend `e2e.spec.ts` with a link → unlink round-trip that proves no plaintext/passphrase/key is sent.

**Files:**
- Modify: `.env`, `.env.test`, `.env.example`
- Modify: `e2e.spec.ts`

**Interfaces:**
- Consumes: `signPendingLink`/`PENDING_LINK_COOKIE` (`@/lib/link-token`), `deriveMasterKey`/`deriveAuthVerifier` (already imported in the e2e).

- [ ] **Step 1: Add the env var**

Generate a value:

```bash
openssl rand -base64 32
```

- In `.env` and `.env.test`, add a line `LINK_STATE_SECRET="<generated value>"` (a **different** value per file is fine; the e2e reads `.env`'s value).
- In `.env.example`, add `LINK_STATE_SECRET=""`.

- [ ] **Step 2: Write the failing e2e test** — append to `e2e.spec.ts`.

First, add the import near the top with the other `@/lib` imports:

```ts
import { signPendingLink, PENDING_LINK_COOKIE } from "@/lib/link-token";
```

Then add a new describe block at the end of the file (before the final EOF):

```ts
describe("google account-linking (live)", () => {
  const linkEmail = `e2e-link-${Date.now()}@example.com`;
  const linkPass = "link-passphrase-123";
  const googleId = `e2e-google-${Date.now()}`;
  const linkSecret = config({ path: ".env" }).parsed?.LINK_STATE_SECRET as string;

  afterAll(async () => {
    await db.user.deleteMany({ where: { email: linkEmail } });
  });

  it("links Google to a password account, then unlinks — no plaintext leaves the client", async () => {
    // Register a password-only account.
    const salt = generateSalt();
    const mk = await deriveMasterKey(linkPass, salt);
    const av = await deriveAuthVerifier(mk, linkPass);
    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: linkEmail, salt, authVerifier: av }),
    });
    expect(reg.status).toBe(201);

    // Mint a pending-link cookie exactly as the callback would (Google step is
    // out of band for the headless harness), then confirm the link with the passphrase.
    const pending = signPendingLink({ googleId, email: linkEmail }, linkSecret);
    const linkRes = await fetch(`${BASE}/api/auth/google/link`, {
      method: "POST",
      headers: { ...json, cookie: `${PENDING_LINK_COOKIE}=${pending}` },
      body: JSON.stringify({ authVerifier: av }),
    });
    expect(linkRes.status).toBe(200);

    // The server persisted the googleId; it never saw the passphrase or master key.
    const linked = await db.user.findUnique({ where: { email: linkEmail } });
    expect(linked?.googleId).toBe(googleId);

    // Capture the session cookie the link set, then unlink with it + the passphrase.
    const setCookies = linkRes.headers.getSetCookie?.() ?? [];
    const session = setCookies.find((c) => c.startsWith("legacy_session="))?.split(";")[0] ?? "";
    expect(session).not.toBe("");
    const unlinkRes = await fetch(`${BASE}/api/auth/google/unlink`, {
      method: "POST",
      headers: { ...json, cookie: session },
      body: JSON.stringify({ authVerifier: av }),
    });
    expect(unlinkRes.status).toBe(200);
    const unlinked = await db.user.findUnique({ where: { email: linkEmail } });
    expect(unlinked?.googleId).toBeNull();
  });

  it("rejects a wrong passphrase (401) and an expired/tampered cookie (400)", async () => {
    const salt = generateSalt();
    const mk = await deriveMasterKey(linkPass, salt);
    const av = await deriveAuthVerifier(mk, linkPass);
    await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: linkEmail, salt, authVerifier: av }),
    }); // 201 or 409 if the previous test's row lingered — either is fine here.

    const pending = signPendingLink({ googleId, email: linkEmail }, linkSecret);
    const wrongPass = await fetch(`${BASE}/api/auth/google/link`, {
      method: "POST",
      headers: { ...json, cookie: `${PENDING_LINK_COOKIE}=${pending}` },
      body: JSON.stringify({ authVerifier: "not-the-verifier" }),
    });
    expect(wrongPass.status).toBe(401);

    const badCookie = await fetch(`${BASE}/api/auth/google/link`, {
      method: "POST",
      headers: { ...json, cookie: `${PENDING_LINK_COOKIE}=garbage.value` },
      body: JSON.stringify({ authVerifier: av }),
    });
    expect(badCookie.status).toBe(400);
  });
});
```

- [ ] **Step 3: Run the unit suite + typecheck (offline gates)**

Run: `npm test && npx tsc --noEmit`
Expected: all unit tests pass (the e2e file is excluded from `npm test`); tsc clean.

- [ ] **Step 4: Run the live e2e** (requires `npm run dev` in another terminal, dev DB reachable, `LINK_STATE_SECRET` set in `.env`)

Run: `npx vitest run --config vitest.e2e.config.ts`
Expected: PASS, including the new `google account-linking (live)` block.

- [ ] **Step 5: Commit**

```bash
git add .env.example e2e.spec.ts
git commit -m "test(e2e): Google account-linking round-trip + no-plaintext proof; add LINK_STATE_SECRET"
```

(`.env` and `.env.test` are gitignored — do not commit them; note the new var in the PR/deploy checklist instead.)

---

## Final verification

- [ ] `npm test` — all unit tests green (expect ~+20 new tests).
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run build` — clean; `/account`, `/api/account/status`, `/api/auth/google/{link,unlink,pending}` present.
- [ ] `npx vitest run --config vitest.e2e.config.ts` — green with the new linking block (dev server + `LINK_STATE_SECRET` required).
- [ ] Update memory: mark Google account-linking DONE; note `LINK_STATE_SECRET` as a new prod env prerequisite.

## Deploy prerequisite (operator action)

Add **`LINK_STATE_SECRET`** (server-only, e.g. `openssl rand -base64 32`) to the production environment before deploy. Reuses the existing `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `APP_BASE_URL`; no new Google Cloud configuration.
