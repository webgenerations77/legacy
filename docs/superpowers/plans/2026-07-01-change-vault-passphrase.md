# Change Vault Passphrase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authenticated, unlocked user rotate their vault passphrase by introducing a wrapped-data-key layer, so the AES-GCM data key stays permanent and only its wrapping changes.

**Architecture:** The passphrase now derives a **KEK** (`= PBKDF2(passphrase, kdfSalt)`, i.e. today's `deriveMasterKey`); the permanent **data key (DK)** is wrapped by the KEK and stored as `{ wrappedKeyCiphertext, wrappedKeyIv }` on `User`. Unlock branches on whether a wrapped key exists (legacy accounts: the derived key *is* the DK). Changing the passphrase re-wraps DK under a new KEK in one atomic row update — no re-encryption, and the survivor escrow (which wraps DK) is untouched.

**Tech Stack:** Next.js 16 App Router (`Request`/`NextResponse`), Prisma 6 → Postgres, WebCrypto (PBKDF2 600k + AES-GCM), bcryptjs, Vitest.

## Global Constraints

- **Zero-knowledge:** only verifiers, the salt, and wrapped-key ciphertext ever leave the browser. The passphrase and the data key (DK) are NEVER sent to the server.
- **DK is permanent:** never re-encrypt records/documents; never re-arm survivor. The survivor escrow wraps DK and must remain byte-for-byte unchanged across a passphrase change.
- **KEK derivation reuses `deriveMasterKey(passphrase, salt)`**; `deriveAuthVerifier(kek, passphrase)` is unchanged. `authVerifier = PBKDF2(KEK, passphrase)`.
- **`wrappedKey` is fetched post-auth only** (a session-scoped GET) and carries `Cache-Control: no-store`. It is never returned by the unauthenticated `getSalt`.
- **Change requires re-auth:** the server bcrypt-verifies the *current* `authVerifier` before an atomic update of exactly `{ kdfSalt, wrappedKeyCiphertext, wrappedKeyIv, authVerifierHash }`. Generic 401 `"That passphrase didn't match."` on any auth failure.
- **Legacy accounts** (no `wrappedKey`) keep working unchanged and upgrade lazily on their first passphrase change. Register is untouched.
- **TypeScript strict:** always run `npx tsc --noEmit`. Unit tests: `npm test` (Vitest). Build gate: `npm run build`. Live e2e: `npx vitest run --config vitest.e2e.config.ts` (needs `npm run dev` + dev DB).
- Migration committed under `prisma/migrations/` and applied to **both** dev (`.env`) and test (`.env.test`) DBs.
- Conventional-commit messages; commit at the end of every task.
- Windows/OneDrive: if `npm run build` fails with EPERM/EBUSY on `.next`, stop any dev server, `rm -rf .next`, retry. Do not start a dev server except where a task explicitly needs the live e2e.

---

### Task 1: Wrap/unwrap crypto helpers

Pure additions to `src/lib/crypto.ts` that wrap/unwrap a data key under a KEK, reusing the existing `encryptItem`/`decryptItem` + base64 helpers (the exact pattern `survivor-crypto.ts` already uses).

**Files:**
- Modify: `src/lib/crypto.ts` (append after `decryptBytes`)
- Test: `src/lib/crypto.test.ts` (append)

**Interfaces:**
- Produces:
  - `wrapDataKey(kek: CryptoBytes, dataKey: CryptoBytes): Promise<{ ciphertext: string; iv: string }>`
  - `unwrapDataKey(kek: CryptoBytes, ciphertext: string, iv: string): Promise<CryptoBytes>`

- [ ] **Step 1: Write the failing test** — append to `src/lib/crypto.test.ts`:

```ts
import { wrapDataKey, unwrapDataKey } from "./crypto";

describe("wrapDataKey / unwrapDataKey", () => {
  it("round-trips a data key through a KEK", async () => {
    const kek = await deriveMasterKey("kek-pass", generateSalt());
    const dataKey = await deriveMasterKey("dk-material", generateSalt());
    const { ciphertext, iv } = await wrapDataKey(kek, dataKey);
    const back = await unwrapDataKey(kek, ciphertext, iv);
    expect(Array.from(back)).toEqual(Array.from(dataKey));
  });

  it("rejects unwrapping with the wrong KEK", async () => {
    const kek = await deriveMasterKey("kek-pass", generateSalt());
    const wrong = await deriveMasterKey("other-pass", generateSalt());
    const dataKey = await deriveMasterKey("dk-material", generateSalt());
    const { ciphertext, iv } = await wrapDataKey(kek, dataKey);
    await expect(unwrapDataKey(wrong, ciphertext, iv)).rejects.toThrow();
  });
});
```

(If `deriveMasterKey`/`generateSalt` are not already imported at the top of `crypto.test.ts`, add them to the existing import from `"./crypto"`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/crypto.test.ts`
Expected: FAIL — `wrapDataKey`/`unwrapDataKey` are not exported.

- [ ] **Step 3: Write minimal implementation** — append to `src/lib/crypto.ts`:

```ts
/**
 * Wrap a permanent data key (DK) under a passphrase-derived key-encrypting key (KEK).
 * Mirrors the survivor escrow: AES-GCM over the base64 of the raw key bytes.
 */
export async function wrapDataKey(
  kek: CryptoBytes,
  dataKey: CryptoBytes,
): Promise<{ ciphertext: string; iv: string }> {
  return encryptItem(kek, bytesToBase64(dataKey));
}

/** Unwrap a data key previously wrapped with wrapDataKey. Throws if the KEK is wrong. */
export async function unwrapDataKey(
  kek: CryptoBytes,
  ciphertext: string,
  iv: string,
): Promise<CryptoBytes> {
  return base64ToBytes(await decryptItem(kek, ciphertext, iv));
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/lib/crypto.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/crypto.ts src/lib/crypto.test.ts
git commit -m "feat(crypto): wrapDataKey/unwrapDataKey helpers for wrapped-key model"
```

---

### Task 2: `User.wrappedKey*` columns + migration

Add two nullable columns and apply the migration to both DBs.

**Files:**
- Modify: `prisma/schema.prisma` (User model)
- Create: `prisma/migrations/<timestamp>_add_wrapped_key/migration.sql` (generated)

**Interfaces:**
- Produces: `User.wrappedKeyCiphertext: string | null`, `User.wrappedKeyIv: string | null` on the Prisma client.

- [ ] **Step 1: Edit the schema** — in `prisma/schema.prisma`, add two fields to the `User` model, right after `authVerifierHash`:

```prisma
  authVerifierHash String?
  wrappedKeyCiphertext String?
  wrappedKeyIv         String?
```

- [ ] **Step 2: Create + apply the migration to the dev DB**

Run: `npx prisma migrate dev --name add_wrapped_key`
Expected: creates `prisma/migrations/<timestamp>_add_wrapped_key/migration.sql` containing two `ALTER TABLE "User" ADD COLUMN ...` statements, applies it to the dev DB, and regenerates the Prisma client. Confirm the SQL is **additive only** (two `ADD COLUMN`, no `DROP`/data change); if it shows anything destructive, STOP and report.

- [ ] **Step 3: Apply the same migration to the test DB**

Run:
```bash
DATABASE_URL="$(grep -E '^DATABASE_URL=' .env.test | head -1 | cut -d= -f2- | tr -d '"')" npx prisma migrate deploy
```
Expected: "1 migration applied" (or "No pending migrations" if already current). Then verify both:
```bash
npx prisma migrate status
DATABASE_URL="$(grep -E '^DATABASE_URL=' .env.test | head -1 | cut -d= -f2- | tr -d '"')" npx prisma migrate status
```
Expected: both report the schema is up to date.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean (the generated client now has the two fields).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): add User.wrappedKey{Ciphertext,Iv} columns + migration (dev+test)"
```

---

### Task 3: `GET /api/auth/vault/wrapped-key`

Session-scoped route returning the wrapped key when present, `null` otherwise. `no-store`.

**Files:**
- Create: `src/app/api/auth/vault/wrapped-key/route.ts`
- Test: `src/app/api/auth/vault/wrapped-key/route.test.ts`

**Interfaces:**
- Consumes: `requireUserId` (`@/lib/route-auth`), `prisma` (`@/lib/db`), `noStore` (`@/lib/http`).
- Produces: `GET(): Response` → `{ wrappedKeyCiphertext: string; wrappedKeyIv: string }` (set) or `{ wrappedKeyCiphertext: null }` (unset), 401 unauth. Both success bodies carry `Cache-Control: no-store`.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/auth/vault/wrapped-key/route.test.ts
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

describe("GET /api/auth/vault/wrapped-key", () => {
  it("401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns the wrapped key pair + no-store when set", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ wrappedKeyCiphertext: "ct", wrappedKeyIv: "iv" });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ wrappedKeyCiphertext: "ct", wrappedKeyIv: "iv" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns null when the account has no wrapped key (legacy)", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ wrappedKeyCiphertext: null, wrappedKeyIv: null });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ wrappedKeyCiphertext: null });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("401 when the user row is missing", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/auth/vault/wrapped-key/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/api/auth/vault/wrapped-key/route.ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/route-auth";
import { noStore } from "@/lib/http";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { wrappedKeyCiphertext: true, wrappedKeyIv: true },
  });
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  if (!user.wrappedKeyCiphertext || !user.wrappedKeyIv) {
    return noStore(NextResponse.json({ wrappedKeyCiphertext: null }));
  }
  return noStore(
    NextResponse.json({
      wrappedKeyCiphertext: user.wrappedKeyCiphertext,
      wrappedKeyIv: user.wrappedKeyIv,
    }),
  );
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/app/api/auth/vault/wrapped-key/route.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/vault/wrapped-key/route.ts src/app/api/auth/vault/wrapped-key/route.test.ts
git commit -m "feat(vault): GET /api/auth/vault/wrapped-key (post-auth, no-store)"
```

---

### Task 4: `POST /api/auth/vault/change-passphrase`

Re-auths the current passphrase, then atomically updates salt + wrapped key + verifier.

**Files:**
- Create: `src/app/api/auth/vault/change-passphrase/route.ts`
- Test: `src/app/api/auth/vault/change-passphrase/route.test.ts`

**Interfaces:**
- Consumes: `requireUserId` (`@/lib/route-auth`), `verifyVerifier`/`hashVerifier` (`@/lib/auth`), `readJsonBody` (`@/lib/http`), `prisma`.
- Produces: `POST(req: Request): Response` — body `{ currentAuthVerifier, kdfSalt, wrappedKeyCiphertext, wrappedKeyIv, authVerifier }`; `{ ok: true }` (200) or 401 (unauth / wrong current), 400 (missing fields).

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/auth/vault/change-passphrase/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUserId = vi.fn();
const findUnique = vi.fn();
const update = vi.fn();
vi.mock("@/lib/route-auth", () => ({ requireUserId: () => requireUserId() }));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a), update: (...a: unknown[]) => update(...a) } },
}));
vi.mock("@/lib/auth", () => ({
  verifyVerifier: async (v: string, h: string) => h === `hash:${v}`,
  hashVerifier: async (v: string) => `hash:${v}`,
}));

import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://localhost/api/auth/vault/change-passphrase", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const good = {
  currentAuthVerifier: "cur",
  kdfSalt: "newsalt",
  wrappedKeyCiphertext: "wct",
  wrappedKeyIv: "wiv",
  authVerifier: "newver",
};

beforeEach(() => {
  requireUserId.mockReset();
  findUnique.mockReset();
  update.mockReset();
});

describe("POST /api/auth/vault/change-passphrase", () => {
  it("401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await POST(req(good))).status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it("400 when a field is missing", async () => {
    requireUserId.mockResolvedValue("u1");
    const { kdfSalt, ...missing } = good;
    void kdfSalt;
    expect((await POST(req(missing))).status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("401 on wrong current passphrase (no update)", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ authVerifierHash: "hash:right" });
    expect((await POST(req({ ...good, currentAuthVerifier: "wrong" }))).status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it("401 when the account has no passphrase set", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ authVerifierHash: null });
    expect((await POST(req(good))).status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it("atomically updates all four fields on correct current passphrase", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ authVerifierHash: "hash:cur" });
    update.mockResolvedValue({});
    const res = await POST(req(good));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: {
        kdfSalt: "newsalt",
        wrappedKeyCiphertext: "wct",
        wrappedKeyIv: "wiv",
        authVerifierHash: "hash:newver",
      },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/auth/vault/change-passphrase/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/api/auth/vault/change-passphrase/route.ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyVerifier, hashVerifier } from "@/lib/auth";
import { requireUserId } from "@/lib/route-auth";
import { readJsonBody } from "@/lib/http";

export async function POST(req: Request) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;

  const currentAuthVerifier =
    typeof body.currentAuthVerifier === "string" ? body.currentAuthVerifier : "";
  const kdfSalt = typeof body.kdfSalt === "string" ? body.kdfSalt : "";
  const wrappedKeyCiphertext =
    typeof body.wrappedKeyCiphertext === "string" ? body.wrappedKeyCiphertext : "";
  const wrappedKeyIv = typeof body.wrappedKeyIv === "string" ? body.wrappedKeyIv : "";
  const authVerifier = typeof body.authVerifier === "string" ? body.authVerifier : "";

  if (!kdfSalt || !wrappedKeyCiphertext || !wrappedKeyIv || !authVerifier) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { authVerifierHash: true },
  });
  const generic = NextResponse.json({ error: "That passphrase didn't match." }, { status: 401 });
  if (!user || !user.authVerifierHash) return generic;
  if (!(await verifyVerifier(currentAuthVerifier, user.authVerifierHash))) return generic;

  await prisma.user.update({
    where: { id: userId },
    data: {
      kdfSalt,
      wrappedKeyCiphertext,
      wrappedKeyIv,
      authVerifierHash: await hashVerifier(authVerifier),
    },
  });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/app/api/auth/vault/change-passphrase/route.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/vault/change-passphrase/route.ts src/app/api/auth/vault/change-passphrase/route.test.ts
git commit -m "feat(vault): POST /api/auth/vault/change-passphrase (re-auth + atomic re-wrap)"
```

---

### Task 5: API-client methods + `resolveDataKey` helper

Client fetch wrappers and the shared unlock helper that turns a passphrase-derived KEK into the real DK.

**Files:**
- Modify: `src/lib/api-client.ts` (add after `vaultUnlock`)
- Create: `src/lib/data-key.ts`
- Test: `src/lib/data-key.test.ts`

**Interfaces:**
- Produces on `api`:
  - `wrappedKey(): Promise<{ wrappedKeyCiphertext: string | null; wrappedKeyIv?: string }>`
  - `changePassphrase(body: { currentAuthVerifier: string; kdfSalt: string; wrappedKeyCiphertext: string; wrappedKeyIv: string; authVerifier: string }): Promise<{ ok: true }>`
- Produces: `resolveDataKey(kek: CryptoBytes): Promise<CryptoBytes>` (`@/lib/data-key`).

- [ ] **Step 1: Add the api-client methods** — in `src/lib/api-client.ts`, insert right after the `vaultUnlock` entry:

```ts
  wrappedKey: async () => {
    const res = await fetch("/api/auth/vault/wrapped-key");
    if (!res.ok) throw new Error("We couldn't load your vault key.");
    return res.json() as Promise<{ wrappedKeyCiphertext: string | null; wrappedKeyIv?: string }>;
  },
  changePassphrase: (body: {
    currentAuthVerifier: string;
    kdfSalt: string;
    wrappedKeyCiphertext: string;
    wrappedKeyIv: string;
    authVerifier: string;
  }) => post<{ ok: true }>("/api/auth/vault/change-passphrase", body),
```

- [ ] **Step 2: Write the failing test for the helper**

```ts
// src/lib/data-key.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const wrappedKey = vi.fn();
vi.mock("@/lib/api-client", () => ({ api: { wrappedKey: () => wrappedKey() } }));

import { resolveDataKey } from "./data-key";
import { deriveMasterKey, generateSalt, wrapDataKey } from "./crypto";

beforeEach(() => wrappedKey.mockReset());

describe("resolveDataKey", () => {
  it("returns the passed KEK when there is no wrapped key (legacy account)", async () => {
    wrappedKey.mockResolvedValue({ wrappedKeyCiphertext: null });
    const kek = await deriveMasterKey("p", generateSalt());
    const dk = await resolveDataKey(kek);
    expect(Array.from(dk)).toEqual(Array.from(kek));
  });

  it("unwraps the data key when a wrapped key is present", async () => {
    const kek = await deriveMasterKey("p", generateSalt());
    const realDk = await deriveMasterKey("dk", generateSalt());
    const { ciphertext, iv } = await wrapDataKey(kek, realDk);
    wrappedKey.mockResolvedValue({ wrappedKeyCiphertext: ciphertext, wrappedKeyIv: iv });
    const dk = await resolveDataKey(kek);
    expect(Array.from(dk)).toEqual(Array.from(realDk));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/data-key.test.ts`
Expected: FAIL — cannot resolve `./data-key`.

- [ ] **Step 4: Write the helper**

```ts
// src/lib/data-key.ts
import { type CryptoBytes, unwrapDataKey } from "@/lib/crypto";
import { api } from "@/lib/api-client";

/**
 * Resolve the permanent data key (DK) from a passphrase-derived KEK.
 * Wrapped accounts: fetch the wrapped key and unwrap it. Legacy accounts (no
 * wrapped key yet): the derived KEK IS the data key. Requires an active session
 * (the wrapped-key fetch is authenticated) — call only after login/unlock succeeds.
 */
export async function resolveDataKey(kek: CryptoBytes): Promise<CryptoBytes> {
  const wk = await api.wrappedKey();
  if (wk.wrappedKeyCiphertext && wk.wrappedKeyIv) {
    return unwrapDataKey(kek, wk.wrappedKeyCiphertext, wk.wrappedKeyIv);
  }
  return kek;
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/lib/data-key.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api-client.ts src/lib/data-key.ts src/lib/data-key.test.ts
git commit -m "feat(vault): api-client wrappedKey/changePassphrase + resolveDataKey helper"
```

---

### Task 6: Route the unlock handlers through `resolveDataKey`

After each auth step succeeds (session established), resolve the real DK before `setMasterKey`.

**Files:**
- Modify: `src/app/unlock/page.tsx`

**Interfaces:**
- Consumes: `resolveDataKey` (`@/lib/data-key`).

- [ ] **Step 1: Import the helper** — in `src/app/unlock/page.tsx`, add to the imports:

```tsx
import { resolveDataKey } from "@/lib/data-key";
```

- [ ] **Step 2: Replace `setMasterKey(masterKey)` in the four submit handlers** with a resolve step. In `onEmailSubmit`, `onCreateSubmit`, `onEnterSubmit`, and `onLinkSubmit`, change the line

```tsx
      setMasterKey(masterKey);
```

to

```tsx
      setMasterKey(await resolveDataKey(masterKey));
```

(All four handlers already run inside `try` blocks after their auth call — `login` / `vaultInit` / `vaultUnlock` / `googleLink` — so a session exists when `resolveDataKey` fetches the wrapped key. `onCreateSubmit` and legacy accounts have no wrapped key, so `resolveDataKey` returns the derived key unchanged.)

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean; `/unlock` present.

- [ ] **Step 4: Commit**

```bash
git add src/app/unlock/page.tsx
git commit -m "feat(vault): unlock resolves the wrapped data key after auth"
```

---

### Task 7: "Change vault passphrase" section on `/account`

Add a settings section that re-auths and re-wraps DK client-side. Gated on the vault being unlocked (DK in memory).

**Files:**
- Modify: `src/app/account/page.tsx`

**Interfaces:**
- Consumes: `useKey` (`@/app/providers/KeyProvider`), `generateSalt`/`deriveMasterKey`/`deriveAuthVerifier`/`wrapDataKey` (`@/lib/crypto`), `api.vaultStatus`/`api.changePassphrase`.

- [ ] **Step 1: Add imports + state.** In `src/app/account/page.tsx`:

Add to the crypto import (it currently imports `deriveMasterKey, deriveAuthVerifier`):

```tsx
import { generateSalt, deriveMasterKey, deriveAuthVerifier, wrapDataKey } from "@/lib/crypto";
import { useKey } from "@/app/providers/KeyProvider";
```

Inside `AccountPage`, add near the other `useState` hooks:

```tsx
  const { masterKey } = useKey();
  const [currentPass, setCurrentPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
```

- [ ] **Step 2: Add the change-passphrase handler** — add near the other handlers:

```tsx
  async function onChangePassphrase(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      if (!masterKey) throw new Error("Unlock your vault first.");
      if (newPass.length < 8) throw new Error("Your new passphrase must be at least 8 characters.");
      if (newPass !== confirmPass) throw new Error("Your new passphrases don't match.");

      // Re-auth with the current passphrase (needs the current KEK salt).
      const st = await api.vaultStatus();
      const currentSalt = st?.salt;
      if (!currentSalt) throw new Error("We couldn't verify your current passphrase.");
      const currentKek = await deriveMasterKey(currentPass, currentSalt);
      const currentAuthVerifier = await deriveAuthVerifier(currentKek, currentPass);

      // Re-wrap the (unchanged) data key under a fresh KEK.
      const newSalt = generateSalt();
      const newKek = await deriveMasterKey(newPass, newSalt);
      const { ciphertext, iv } = await wrapDataKey(newKek, masterKey);
      const newAuthVerifier = await deriveAuthVerifier(newKek, newPass);

      await api
        .changePassphrase({
          currentAuthVerifier,
          kdfSalt: newSalt,
          wrappedKeyCiphertext: ciphertext,
          wrappedKeyIv: iv,
          authVerifier: newAuthVerifier,
        })
        .catch(() => {
          throw new Error("That passphrase didn't match.");
        });

      setNotice("Your vault passphrase has been changed.");
      setCurrentPass("");
      setNewPass("");
      setConfirmPass("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't change your passphrase.");
    } finally {
      setBusy(false);
    }
  }
```

- [ ] **Step 3: Render the section.** Add this block inside the card, right before the closing `{notice && ...}` / `{error && ...}` lines (i.e. after the Google `mode === "idle"` block):

```tsx
        <div style={{ marginTop: "1.5rem" }}>
          <h2>Change vault passphrase</h2>
          {!masterKey ? (
            <p className="subtle">
              <a className="linkbtn" href="/unlock">Unlock your vault</a> to change your passphrase.
            </p>
          ) : (
            <form onSubmit={onChangePassphrase}>
              <label htmlFor="cur">Current passphrase</label>
              <input id="cur" type="password" value={currentPass}
                onChange={(e) => setCurrentPass(e.target.value)} required />
              <label htmlFor="new">New passphrase</label>
              <input id="new" type="password" value={newPass}
                onChange={(e) => setNewPass(e.target.value)} required minLength={8} />
              <label htmlFor="cf">Confirm new passphrase</label>
              <input id="cf" type="password" value={confirmPass}
                onChange={(e) => setConfirmPass(e.target.value)} required minLength={8} />
              <button type="submit" disabled={busy}>
                {busy ? "Changing…" : "Change passphrase"}
              </button>
            </form>
          )}
        </div>
```

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean; `/account` present.

- [ ] **Step 5: Commit**

```bash
git add src/app/account/page.tsx
git commit -m "feat(vault): /account 'Change vault passphrase' section (re-auth + re-wrap)"
```

---

### Task 8: Live e2e — change passphrase, data survives, survivor intact

**Files:**
- Modify: `e2e.spec.ts`

**Interfaces:**
- Consumes: existing e2e helpers (`generateSalt`, `deriveMasterKey`, `deriveAuthVerifier`, `encryptItem`, `decryptItem`, `db`, `BASE`, `json`), `wrapDataKey`/`unwrapDataKey` (`@/lib/crypto`), `buildSurvivorEscrow`/`recoverMasterKey` (`@/lib/survivor-crypto`).

- [ ] **Step 1: Ensure imports.** In `e2e.spec.ts`, add `wrapDataKey, unwrapDataKey` to the existing `@/lib/crypto` import if not present. (`buildSurvivorEscrow`/`recoverMasterKey` are already imported.)

- [ ] **Step 2: Append the failing e2e block** at the end of `e2e.spec.ts`:

```ts
describe("change vault passphrase (live)", () => {
  const cpEmail = `e2e-cp-${Date.now()}@example.com`;
  const oldPass = "old-passphrase-123";
  const newPass = "new-passphrase-456";
  const secretText = "The spare key is under the third flowerpot.";

  afterAll(async () => {
    await db.user.deleteMany({ where: { email: cpEmail } });
  });

  it("rotates the passphrase without re-encrypting data or breaking survivor access", async () => {
    // Register (legacy account: DK == master key derived from the passphrase).
    const oldSalt = generateSalt();
    const dk = await deriveMasterKey(oldPass, oldSalt); // this is the permanent data key
    const oldAv = await deriveAuthVerifier(dk, oldPass);
    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: cpEmail, salt: oldSalt, authVerifier: oldAv }),
    });
    expect(reg.status).toBe(201);

    // Log in → session cookie.
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: cpEmail, authVerifier: oldAv }),
    });
    expect(login.status).toBe(200);
    const session = (login.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("legacy_session="))?.split(";")[0] ?? "";
    expect(session).not.toBe("");
    const authed = { ...json, cookie: session };

    // Store an encrypted vault item under the data key.
    const item = await encryptItem(dk, secretText);
    const add = await fetch(`${BASE}/api/vault`, {
      method: "POST", headers: authed, body: JSON.stringify(item),
    });
    expect(add.status).toBe(201);

    // Arm survivor (escrow wraps the data key). Record the escrow to prove it is untouched.
    const arm = await buildSurvivorEscrow(dk);
    const armRes = await fetch(`${BASE}/api/survivor`, {
      method: "POST", headers: authed,
      body: JSON.stringify({
        survivorSalt: arm.survivorSalt,
        survivorAuthVerifier: arm.survivorAuthVerifier,
        escrowCiphertext: arm.escrowCiphertext,
        escrowIv: arm.escrowIv,
      }),
    });
    expect(armRes.status).toBe(200);
    const escrowBefore = await db.survivorAccess.findFirst({
      where: { user: { email: cpEmail } },
      select: { escrowCiphertext: true, escrowIv: true },
    });

    // Change the passphrase: re-wrap the SAME data key under a new KEK.
    const newSalt = generateSalt();
    const newKek = await deriveMasterKey(newPass, newSalt);
    const wrapped = await wrapDataKey(newKek, dk);
    const newAv = await deriveAuthVerifier(newKek, newPass);
    const change = await fetch(`${BASE}/api/auth/vault/change-passphrase`, {
      method: "POST", headers: authed,
      body: JSON.stringify({
        currentAuthVerifier: oldAv,
        kdfSalt: newSalt,
        wrappedKeyCiphertext: wrapped.ciphertext,
        wrappedKeyIv: wrapped.iv,
        authVerifier: newAv,
      }),
    });
    expect(change.status).toBe(200);

    // DB: authVerifierHash changed (bcrypt) and wrappedKeyCiphertext now populated.
    const row = await db.user.findUnique({
      where: { email: cpEmail },
      select: { authVerifierHash: true, wrappedKeyCiphertext: true, kdfSalt: true },
    });
    expect(row?.wrappedKeyCiphertext).toBeTruthy();
    expect(row?.authVerifierHash?.startsWith("$2")).toBe(true);
    expect(row?.kdfSalt).toBe(newSalt);

    // Survivor escrow is byte-for-byte unchanged (data key never moved).
    const escrowAfter = await db.survivorAccess.findFirst({
      where: { user: { email: cpEmail } },
      select: { escrowCiphertext: true, escrowIv: true },
    });
    expect(escrowAfter).toEqual(escrowBefore);
    // …and it still recovers the same data key.
    const recovered = await recoverMasterKey(arm.recoveryCode, arm.survivorSalt, arm.escrowCiphertext, arm.escrowIv);
    expect(Array.from(recovered)).toEqual(Array.from(dk));

    // Old passphrase no longer logs in.
    const oldLogin = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: cpEmail, authVerifier: oldAv }),
    });
    expect(oldLogin.status).toBe(401);

    // New passphrase logs in, unwraps the data key, and decrypts the stored item.
    const newLogin = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: cpEmail, authVerifier: newAv }),
    });
    expect(newLogin.status).toBe(200);
    const session2 = (newLogin.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("legacy_session="))?.split(";")[0] ?? "";
    const authed2 = { cookie: session2 };

    const wkRes = await fetch(`${BASE}/api/auth/vault/wrapped-key`, { headers: authed2 });
    expect(wkRes.status).toBe(200);
    const wk = await wkRes.json();
    const dk2 = await unwrapDataKey(newKek, wk.wrappedKeyCiphertext, wk.wrappedKeyIv);
    expect(Array.from(dk2)).toEqual(Array.from(dk));

    const listRes = await fetch(`${BASE}/api/vault`, { headers: authed2 });
    const list = (await listRes.json()) as { items: Array<{ ciphertext: string; iv: string }> };
    const decrypted = await Promise.all(list.items.map((r) => decryptItem(dk2, r.ciphertext, r.iv)));
    expect(decrypted).toContain(secretText);
  });
});
```

(`GET /api/vault` returns `{ items: [...] }` — the vault route's `listKey` is `"items"`.)

- [ ] **Step 3: Run the offline gates**

Run: `npm test && npx tsc --noEmit`
Expected: unit suite green (e2e excluded from `npm test`); tsc clean.

- [ ] **Step 4: Run the live e2e** (needs `npm run dev` in another terminal + dev DB with the migration applied)

Run: `npx vitest run --config vitest.e2e.config.ts`
Expected: PASS, including `change vault passphrase (live)`.

- [ ] **Step 5: Commit**

```bash
git add e2e.spec.ts
git commit -m "test(e2e): change-passphrase round-trip — data survives, survivor escrow intact"
```

---

## Final verification

- [ ] `npm test` — all unit tests green (expect ~+15 new).
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run build` — clean; `/api/auth/vault/wrapped-key` and `/api/auth/vault/change-passphrase` present, `/account` + `/unlock` present.
- [ ] `npx vitest run --config vitest.e2e.config.ts` — green with the new change-passphrase block.
- [ ] Update memory: change-passphrase DONE; note the wrapped-key model is now the foundation (legacy accounts upgrade on first change), and that add-password-to-Google-only becomes easy on top of it.

## Notes for the implementer

- No new environment variables. No new deploy prerequisites.
- Task 2 touches the dev + test databases (additive `ADD COLUMN` only). If any migration output looks destructive, stop and report rather than proceeding.
