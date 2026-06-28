# Legacy Financial Accounts (Sprint 2 Slice 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A zero-knowledge Financial Accounts walking skeleton — add an encrypted 6-field account record → list it → decrypt and display it — reusing the Sprint 1 crypto/auth foundation unchanged.

**Architecture:** A financial account is a typed object serialized to JSON, encrypted client-side with the existing `encryptItem` into one opaque `{ciphertext, iv}` blob, and stored in a new `FinancialAccount` table that mirrors `VaultItem`. New `/api/accounts` routes (parallel to the vault routes) and an `/accounts` page (parallel to the vault page) consume it; a shared `AppNav` links Vault and Accounts.

**Tech Stack:** Next.js 16 (App Router, TS strict) · Prisma 6 → PostgreSQL · existing WebCrypto module · Vitest.

## Global Constraints

- **Zero-knowledge:** the passphrase, master key, and plaintext account fields must never reach the server. The server persists only `ciphertext`, `iv`, `userId`, timestamps.
- **Reuse, do not modify:** `encryptItem`/`decryptItem` (`@/lib/crypto`), `useKey`/`KeyProvider`, `getSessionUserId` (`@/lib/auth`), `readJsonBody` (`@/lib/http`), `SESSION_COOKIE` (`@/lib/session-cookie`).
- **TypeScript strict; no `any`** in committed code.
- **Calm, supportive copy** per the Legacy design system; reuse existing CSS classes; `--alert` color for errors only.
- **Migrations applied to BOTH** dev (`.env`) and test (`.env.test`) databases.
- **Account fields (encrypted together):** `type` (Checking|Savings|Investment|Retirement|Other), `institution`, `nickname`, `accountNumber`, `balance`, `notes`.
- **Commit footer** on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Git identity: `-c user.name="Legacy" -c user.email="webgenerations77@gmail.com"`.

---

## File Structure

```
src/lib/account.ts                 # Account type + serialize/parse/mask (pure) — TDD
src/lib/account.test.ts            # unit tests
prisma/schema.prisma               # + FinancialAccount model (modify)
src/app/api/accounts/route.ts      # GET list + POST create (session-gated)
src/lib/api-client.ts              # + listAccounts / addAccount (modify)
src/components/AppNav.tsx          # Vault · Accounts nav + Lock & sign out
src/app/vault/page.tsx             # use AppNav (modify: move logout into AppNav)
src/app/accounts/page.tsx          # account add form + decrypted list
src/app/globals.css                # + nav / select / textarea / meta styles (modify)
e2e.spec.ts                        # + account round-trip + zero-knowledge check (modify)
```

---

## Task 1: Account domain module (TDD)

**Files:**
- Create: `src/lib/account.ts`, `src/lib/account.test.ts`

**Interfaces:**
- Produces:
  - `type AccountType = "Checking" | "Savings" | "Investment" | "Retirement" | "Other"`
  - `interface Account { type: AccountType; institution: string; nickname: string; accountNumber: string; balance: string; notes: string }`
  - `serializeAccount(a: Account): string`
  - `parseAccount(json: string): Account`
  - `maskAccountNumber(value: string): string`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/account.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  serializeAccount,
  parseAccount,
  maskAccountNumber,
  type Account,
} from "@/lib/account";

const sample: Account = {
  type: "Savings",
  institution: "First National Bank",
  nickname: "Rainy day",
  accountNumber: "123456784821",
  balance: "12,500",
  notes: "Auto-pays the mortgage",
};

describe("account domain", () => {
  it("round-trips through serialize/parse", () => {
    expect(parseAccount(serializeAccount(sample))).toEqual(sample);
  });

  it("masks an account number to the last four digits", () => {
    expect(maskAccountNumber("123456784821")).toBe("••••4821");
  });

  it("returns short numbers unmasked and empty as empty", () => {
    expect(maskAccountNumber("4821")).toBe("4821");
    expect(maskAccountNumber("12")).toBe("12");
    expect(maskAccountNumber("")).toBe("");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/lib/account.test.ts
```
Expected: FAIL — cannot resolve `@/lib/account`.

- [ ] **Step 3: Implement the module**

Create `src/lib/account.ts`:

```ts
export type AccountType =
  | "Checking"
  | "Savings"
  | "Investment"
  | "Retirement"
  | "Other";

export interface Account {
  type: AccountType;
  institution: string;
  nickname: string;
  accountNumber: string;
  balance: string;
  notes: string;
}

export function serializeAccount(account: Account): string {
  return JSON.stringify(account);
}

export function parseAccount(json: string): Account {
  return JSON.parse(json) as Account;
}

export function maskAccountNumber(value: string): string {
  if (value.length <= 4) return value;
  return "••••" + value.slice(-4);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/lib/account.test.ts
```
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/account.ts src/lib/account.test.ts
git commit -m "feat: add account domain module (serialize/parse/mask)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: FinancialAccount model + migration

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: a `FinancialAccount` table with `{ id, userId, ciphertext, iv, createdAt }` and a `User.financialAccounts` relation; Prisma client regenerated.

- [ ] **Step 1: Add the model and relation**

In `prisma/schema.prisma`, add the new model:

```prisma
model FinancialAccount {
  id         String   @id @default(cuid())
  userId     String
  ciphertext String
  iv         String
  createdAt  DateTime @default(now())
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

And add this line to the `User` model's field list (next to `vaultItems`):

```prisma
  financialAccounts FinancialAccount[]
```

- [ ] **Step 2: Create + apply the migration on the dev database**

```bash
npx prisma migrate dev --name financial_accounts
```
Expected: new migration created under `prisma/migrations/`, applied, "Your database is now in sync", Prisma Client regenerated.

- [ ] **Step 3: Apply the migration to the test database**

```bash
npx dotenv -e .env.test -- npx prisma migrate deploy
```
Expected: the `financial_accounts` migration is applied to the test DB ("All migrations have been successfully applied").

- [ ] **Step 4: Verify the client typechecks**

```bash
npx tsc --noEmit
```
Expected: exit 0 (no errors).

- [ ] **Step 5: Commit**

```bash
git add prisma
git commit -m "feat: add FinancialAccount model and migration

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Accounts API routes + typed client

**Files:**
- Create: `src/app/api/accounts/route.ts`
- Modify: `src/lib/api-client.ts`

**Interfaces:**
- Consumes: `prisma` (`@/lib/db`), `getSessionUserId` (`@/lib/auth`), `SESSION_COOKIE` (`@/lib/session-cookie`), `readJsonBody` (`@/lib/http`).
- Produces:
  - `GET /api/accounts` → 200 `{ accounts: { id, ciphertext, iv }[] }` (newest first); 401
  - `POST /api/accounts` body `{ ciphertext, iv }` → 201 `{ id }`; 400; 401
  - client: `api.listAccounts(): Promise<{ accounts: { id: string; ciphertext: string; iv: string }[] }>`, `api.addAccount(ciphertext: string, iv: string): Promise<{ id: string }>`

- [ ] **Step 1: Implement the route handlers**

Create `src/app/api/accounts/route.ts` (mirrors `src/app/api/vault/route.ts`):

```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import { readJsonBody } from "@/lib/http";

async function requireUser(): Promise<string | null> {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  return getSessionUserId(sid);
}

export async function GET() {
  const userId = await requireUser();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const accounts = await prisma.financialAccount.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, ciphertext: true, iv: true },
  });
  return NextResponse.json({ accounts });
}

export async function POST(req: Request) {
  const userId = await requireUser();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const ciphertext = typeof body.ciphertext === "string" ? body.ciphertext : "";
  const iv = typeof body.iv === "string" ? body.iv : "";
  if (!ciphertext || !iv) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }

  const account = await prisma.financialAccount.create({
    data: { userId, ciphertext, iv },
    select: { id: true },
  });
  return NextResponse.json({ id: account.id }, { status: 201 });
}
```

- [ ] **Step 2: Add the typed client wrappers**

In `src/lib/api-client.ts`, add these two entries to the `api` object (alongside the vault wrappers; follow the existing `listVault`/`addVaultItem` style):

```ts
  listAccounts: async () => {
    const res = await fetch("/api/accounts");
    if (!res.ok) throw new Error("We couldn't load your accounts.");
    return res.json() as Promise<{
      accounts: { id: string; ciphertext: string; iv: string }[];
    }>;
  },
  addAccount: (ciphertext: string, iv: string) =>
    post<{ id: string }>("/api/accounts", { ciphertext, iv }),
```

- [ ] **Step 3: Verify it compiles and builds**

```bash
npx tsc --noEmit && npm run build 2>&1 | tail -6
```
Expected: type-check clean; build succeeds with `/api/accounts` in the route list.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/accounts src/lib/api-client.ts
git commit -m "feat: add accounts api routes and typed client wrappers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: AppNav component + vault page integration

**Files:**
- Create: `src/components/AppNav.tsx`
- Modify: `src/app/vault/page.tsx`, `src/app/globals.css`

**Interfaces:**
- Consumes: `api.logout` (`@/lib/api-client`), `useKey` (`@/app/providers/KeyProvider`), `next/navigation`, `next/link`.
- Produces: `AppNav` React component (renders Vault/Accounts links + a Lock & sign out button that logs out, clears the in-memory key, and redirects to `/unlock`).

- [ ] **Step 1: Create the AppNav component**

Create `src/components/AppNav.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { useKey } from "@/app/providers/KeyProvider";

export function AppNav() {
  const router = useRouter();
  const { setMasterKey } = useKey();

  async function onLogout() {
    try {
      await api.logout();
    } catch {
      // best-effort: always clear the in-memory key and leave
    }
    setMasterKey(null);
    router.replace("/unlock");
  }

  return (
    <nav className="appnav">
      <div className="navlinks">
        <Link href="/vault">Vault</Link>
        <Link href="/accounts">Accounts</Link>
      </div>
      <button type="button" className="linkbtn" onClick={onLogout}>
        Lock &amp; sign out
      </button>
    </nav>
  );
}
```

- [ ] **Step 2: Add nav styles**

Append to `src/app/globals.css`:

```css
/* App navigation */
.appnav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--blue-200);
}
.navlinks {
  display: flex;
  gap: 16px;
}
.navlinks a {
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
  font-size: 0.95rem;
}
.navlinks a:hover {
  text-decoration: underline;
}
```

- [ ] **Step 3: Integrate AppNav into the vault page and remove its inline logout**

In `src/app/vault/page.tsx`:

(a) Add the import near the other imports:
```tsx
import { AppNav } from "@/components/AppNav";
```

(b) Change the `useKey` destructure from `const { masterKey, setMasterKey } = useKey();` to:
```tsx
  const { masterKey } = useKey();
```

(c) Delete the entire `onLogout` function:
```tsx
  async function onLogout() {
    try {
      await api.logout();
    } catch {
      // best-effort: always clear the in-memory key and leave the vault
    }
    setMasterKey(null);
    router.replace("/unlock");
  }
```

(d) Replace the brand block at the top of the returned card:
```tsx
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Your Vault</h1>
```
with:
```tsx
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Your Vault</h1>
```

(e) Delete the old logout line near the bottom of the card:
```tsx
        <p className="link"><button type="button" className="linkbtn" onClick={onLogout}>Lock &amp; sign out</button></p>
```

- [ ] **Step 4: Verify it compiles and builds**

```bash
npx tsc --noEmit && npm run build 2>&1 | tail -6
```
Expected: clean type-check (no "unused `setMasterKey`/`onLogout`" errors — they were removed); build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/AppNav.tsx src/app/vault/page.tsx src/app/globals.css
git commit -m "feat: add AppNav (vault/accounts) and move logout into it

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Accounts page

**Files:**
- Create: `src/app/accounts/page.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes: `api.listAccounts`/`api.addAccount` (`@/lib/api-client`), `AppNav` (`@/components/AppNav`), `LegacyMark` (`@/components/Logo`), `useKey` (`@/app/providers/KeyProvider`), `encryptItem`/`decryptItem` (`@/lib/crypto`), `Account`/`AccountType`/`serializeAccount`/`parseAccount`/`maskAccountNumber` (`@/lib/account`).

- [ ] **Step 1: Add form/list styles**

Append to `src/app/globals.css` (extends existing input styling to `select`/`textarea` and adds account-card detail classes):

```css
/* Forms: match inputs for select + textarea */
select,
textarea {
  width: 100%;
  padding: 11px 13px;
  border: 1px solid var(--blue-200);
  border-radius: var(--radius-input);
  font-size: 1rem;
  font-family: var(--font-body);
  background: var(--paper);
  color: var(--ink);
}
textarea {
  min-height: 70px;
  resize: vertical;
}
select:focus,
textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--blue-100);
  background: #fff;
}

/* Account card details */
.item strong {
  display: block;
  font-family: var(--font-head);
  font-weight: 500;
  font-size: 1.05rem;
}
.item .meta {
  font-family: var(--font-label);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.68rem;
  color: var(--muted);
  margin-top: 3px;
}
.item .notes {
  margin-top: 6px;
  font-size: 0.92rem;
  color: var(--slate);
}
```

- [ ] **Step 2: Create the accounts page**

Create `src/app/accounts/page.tsx`:

```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { useKey } from "@/app/providers/KeyProvider";
import { encryptItem, decryptItem } from "@/lib/crypto";
import {
  type Account,
  type AccountType,
  serializeAccount,
  parseAccount,
  maskAccountNumber,
} from "@/lib/account";

const TYPES: AccountType[] = [
  "Checking",
  "Savings",
  "Investment",
  "Retirement",
  "Other",
];

const EMPTY: Account = {
  type: "Checking",
  institution: "",
  nickname: "",
  accountNumber: "",
  balance: "",
  notes: "",
};

export default function AccountsPage() {
  const router = useRouter();
  const { masterKey } = useKey();
  const [items, setItems] = useState<{ id: string; account: Account | null }[]>([]);
  const [draft, setDraft] = useState<Account>(EMPTY);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!masterKey) return;
    const { accounts } = await api.listAccounts();
    const decrypted = await Promise.all(
      accounts.map(async (a) => {
        try {
          const json = await decryptItem(masterKey, a.ciphertext, a.iv);
          return { id: a.id, account: parseAccount(json) };
        } catch {
          return { id: a.id, account: null };
        }
      }),
    );
    setItems(decrypted);
    setLoaded(true);
  }, [masterKey]);

  useEffect(() => {
    if (!masterKey) {
      router.replace("/unlock");
      return;
    }
    load().catch(() =>
      setError("We couldn't load your accounts. Please try unlocking again."),
    );
  }, [masterKey, load, router]);

  function set<K extends keyof Account>(key: K, value: Account[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!masterKey || !draft.nickname.trim()) return;
    setError("");
    try {
      const { ciphertext, iv } = await encryptItem(masterKey, serializeAccount(draft));
      await api.addAccount(ciphertext, iv);
      setDraft(EMPTY);
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "We couldn't save that. Please try again.",
      );
    }
  }

  if (!masterKey) return null;

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Financial Accounts</h1>
        <p className="subtle">Each account is encrypted on your device.</p>

        <form onSubmit={onAdd}>
          <label htmlFor="type">Type</label>
          <select
            id="type"
            value={draft.type}
            onChange={(e) => set("type", e.target.value as AccountType)}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <label htmlFor="institution">Institution</label>
          <input
            id="institution"
            value={draft.institution}
            onChange={(e) => set("institution", e.target.value)}
          />

          <label htmlFor="nickname">Nickname</label>
          <input
            id="nickname"
            value={draft.nickname}
            onChange={(e) => set("nickname", e.target.value)}
            required
          />

          <label htmlFor="accountNumber">Account number</label>
          <input
            id="accountNumber"
            value={draft.accountNumber}
            onChange={(e) => set("accountNumber", e.target.value)}
          />

          <label htmlFor="balance">Approx. balance</label>
          <input
            id="balance"
            value={draft.balance}
            onChange={(e) => set("balance", e.target.value)}
          />

          <label htmlFor="notes">Notes</label>
          <textarea
            id="notes"
            value={draft.notes}
            onChange={(e) => set("notes", e.target.value)}
          />

          <button type="submit">Add account</button>
        </form>

        {error && <p className="error">{error}</p>}
        {loaded && items.length === 0 && (
          <p className="subtle">No accounts yet. Add your first above.</p>
        )}
        {items.map((it) => (
          <div className="item" key={it.id}>
            {it.account ? (
              <>
                <strong>{it.account.nickname || "Untitled account"}</strong>
                <div className="meta">
                  {it.account.type}
                  {it.account.institution ? ` · ${it.account.institution}` : ""}
                </div>
                {it.account.accountNumber && (
                  <div className="meta">{maskAccountNumber(it.account.accountNumber)}</div>
                )}
                {it.account.balance && <div className="meta">Balance: {it.account.balance}</div>}
                {it.account.notes && <div className="notes">{it.account.notes}</div>}
              </>
            ) : (
              "We couldn't unlock this account."
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Verify it compiles and builds**

```bash
npx tsc --noEmit && npm run build 2>&1 | tail -8
```
Expected: type-check clean; build succeeds with `/accounts` in the route list.

- [ ] **Step 4: Commit**

```bash
git add src/app/accounts src/app/globals.css
git commit -m "feat: add financial accounts page (encrypted add + decrypted list)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Extend end-to-end verification

**Files:**
- Modify: `e2e.spec.ts`

**Interfaces:**
- Consumes: existing e2e helpers + `@/lib/account`, `@/lib/crypto`.

- [ ] **Step 1: Add an accounts round-trip assertion to the live e2e**

In `e2e.spec.ts`, add these imports to the existing crypto import block:

```ts
import { serializeAccount, parseAccount, type Account } from "@/lib/account";
```

Then add a new test inside the existing `describe("walking skeleton (live)", ...)` block (it reuses the same logged-in flow pattern; it registers its own user so it is self-contained):

```ts
  it("stores and reads back an encrypted financial account", async () => {
    const aEmail = `e2e-acct-${Date.now()}@example.com`;
    const pass = "account-passphrase-123";

    // register + login
    const salt = generateSalt();
    const mk = await deriveMasterKey(pass, salt);
    const av = await deriveAuthVerifier(mk, pass);
    await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: aEmail, salt, authVerifier: av }),
    });
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: aEmail, authVerifier: av }),
    });
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    // encrypt + store an account
    const account: Account = {
      type: "Savings",
      institution: "First National Bank",
      nickname: "Rainy day",
      accountNumber: "123456784821",
      balance: "12,500",
      notes: "Auto-pays the mortgage",
    };
    const { ciphertext, iv } = await encryptItem(mk, serializeAccount(account));
    const add = await fetch(`${BASE}/api/accounts`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ ciphertext, iv }),
    });
    expect(add.status).toBe(201);

    // list + decrypt
    const list = await fetch(`${BASE}/api/accounts`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const { accounts } = await list.json();
    expect(accounts).toHaveLength(1);
    const back = parseAccount(await decryptItem(mk, accounts[0].ciphertext, accounts[0].iv));
    expect(back).toEqual(account);

    // zero-knowledge: stored row has no plaintext
    const user = await db.user.findUnique({
      where: { email: aEmail },
      include: { financialAccounts: true },
    });
    const stored = user!.financialAccounts[0];
    expect(stored.ciphertext).not.toContain("First National");
    expect(stored.ciphertext).not.toContain("123456784821");

    // cleanup
    await db.user.delete({ where: { email: aEmail } });
  }, 60_000);
```

- [ ] **Step 2: Run the unit suite (no server needed)**

```bash
npx vitest run
```
Expected: all unit tests pass (crypto 5 + auth 4 + account 3 = 12). The e2e file is excluded from this config.

- [ ] **Step 3: Run the live e2e against a dev server**

In one shell, start the server (leave it running): `npm run dev`. Wait until `http://localhost:3000/unlock` returns 200, then in another shell:

```bash
npx vitest run --config vitest.e2e.config.ts
```
Expected: 2/2 e2e tests pass (the original vault round-trip + the new account round-trip). Stop the dev server afterward.

- [ ] **Step 4: Commit**

```bash
git add e2e.spec.ts
git commit -m "test: extend e2e with encrypted financial account round-trip

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **Reuse only.** Do not modify `src/lib/crypto.ts`, `src/lib/auth.ts`, `src/lib/http.ts`, or `KeyProvider`. The account record is just a JSON string handed to the existing `encryptItem`.
- **Test DB is already configured** via `.env.test` + `vitest.setup.ts`; run unit tests with plain `npx vitest run`.
- **Windows/Bash:** `npx dotenv -e .env.test -- ...` is cross-platform for the test-DB migration.
- **Zero-knowledge check is the point** of the e2e addition — the stored `ciphertext` must not contain `institution` or `accountNumber` plaintext.
