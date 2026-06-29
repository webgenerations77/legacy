# Shared Encrypted-Record Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the duplicated zero-knowledge add-and-list machinery shared by vault, accounts, and bills into one server route factory (`createEncryptedRecordRoute`) and one client hook (`useEncryptedRecords`), with zero behavior change.

**Architecture:** A behavior-preserving refactor. The factory absorbs the three identical route handlers (auth gate, list, validate-and-create) behind a `{ model, listKey }` config. The hook absorbs the three identical page control layers (key gate, `/unlock` redirect, decrypt-on-load, encrypt-on-add, error/empty state); pages keep their bespoke forms and cards. The existing unit suite (18/18) and live e2e (3/3) are the correctness proof and must pass unchanged.

**Tech Stack:** Next.js 16 (App Router, TS strict), Prisma 6, browser WebCrypto (`@/lib/crypto`), Vitest 4.

## Global Constraints

- **Behavior-preserving:** no change to API contracts (status codes, response keys `items`/`accounts`/`bills`, error copy), stored data, or user-visible UI — except the single documented vault null-marker equivalence (Task 2). Existing unit tests and the live e2e must pass **unchanged**; editing a test to make it pass means behavior changed and is wrong.
- Zero-knowledge: server stores/returns only `{ ciphertext, iv }` (+ `userId`, timestamps); all encrypt/decrypt stays client-side via the unchanged `@/lib/crypto`.
- TypeScript strict; no `any`. Prisma model access is via a typed switch, not a string index (a single `as unknown as` structural cast to bridge Prisma's union typing is permitted — it is not `any`).
- Reuse existing helpers unchanged: `getSessionUserId` (`@/lib/auth`, takes `string | undefined`), `readJsonBody` (`@/lib/http`), `SESSION_COOKIE` (`@/lib/session-cookie`), `prisma` (`@/lib/db`), `encryptItem`/`decryptItem` (`@/lib/crypto`), `useKey` (`@/app/providers/KeyProvider`).
- Calm Legacy copy retained verbatim; `--alert`/`.error` for failures only.
- No schema or migration changes.
- Unit tests: `npm test` (= `vitest run`), files as `*.test.ts`. Gates per task: `npx tsc --noEmit` and `npm run build`.
- Live e2e (separate config): `npx vitest run --config vitest.e2e.config.ts` against a running `npm run dev` + the dev DB. Known gotcha: if `/api/*` 404s, stop dev server, delete `.next`, restart (`.next` deletion can EPERM on Windows if the server holds it).

---

### Task 1: `createEncryptedRecordRoute` factory + rewire the three routes

**Files:**
- Create: `src/lib/encrypted-record-route.ts`
- Create: `src/lib/encrypted-record-route.test.ts`
- Modify: `src/app/api/vault/route.ts` (replace body with one-line wiring)
- Modify: `src/app/api/accounts/route.ts` (same)
- Modify: `src/app/api/bills/route.ts` (same)

**Interfaces:**
- Consumes: `prisma` (`@/lib/db`), `getSessionUserId` (`@/lib/auth`), `SESSION_COOKIE` (`@/lib/session-cookie`), `readJsonBody` (`@/lib/http`).
- Produces: `createEncryptedRecordRoute(opts: { model: "vaultItem" | "financialAccount" | "bill"; listKey: string }): { GET: () => Promise<NextResponse>; POST: (req: Request) => Promise<NextResponse> }`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/encrypted-record-route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const getSessionUserId = vi.fn();
const findMany = vi.fn();
const create = vi.fn();

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "sid-123" }) }),
}));
vi.mock("@/lib/auth", () => ({
  getSessionUserId: (...args: unknown[]) => getSessionUserId(...args),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    bill: {
      findMany: (...a: unknown[]) => findMany(...a),
      create: (...a: unknown[]) => create(...a),
    },
  },
}));

import { createEncryptedRecordRoute } from "@/lib/encrypted-record-route";

const { GET, POST } = createEncryptedRecordRoute({ model: "bill", listKey: "bills" });

function postReq(body: unknown) {
  return new Request("http://localhost/api/bills", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getSessionUserId.mockReset();
  findMany.mockReset();
  create.mockReset();
});

describe("createEncryptedRecordRoute", () => {
  it("GET returns 401 when unauthenticated", async () => {
    getSessionUserId.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("GET lists rows under the configured key when authenticated", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    findMany.mockResolvedValue([{ id: "b1", ciphertext: "c", iv: "i" }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bills: [{ id: "b1", ciphertext: "c", iv: "i" }] });
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { createdAt: "desc" },
      select: { id: true, ciphertext: true, iv: true },
    });
  });

  it("POST returns 401 when unauthenticated", async () => {
    getSessionUserId.mockResolvedValue(null);
    const res = await POST(postReq({ ciphertext: "c", iv: "i" }));
    expect(res.status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it("POST returns 400 when fields are missing or non-string", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    expect((await POST(postReq({ ciphertext: "c" }))).status).toBe(400);
    expect((await POST(postReq({ ciphertext: 123, iv: "i" }))).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("POST creates and returns 201 with the new id", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    create.mockResolvedValue({ id: "new-id" });
    const res = await POST(postReq({ ciphertext: "c", iv: "i" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "new-id" });
    expect(create).toHaveBeenCalledWith({
      data: { userId: "user-1", ciphertext: "c", iv: "i" },
      select: { id: true },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/encrypted-record-route.test.ts`
Expected: FAIL — cannot resolve module `@/lib/encrypted-record-route`.

- [ ] **Step 3: Write the factory**

Create `src/lib/encrypted-record-route.ts`:

```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import { readJsonBody } from "@/lib/http";

type RecordModel = "vaultItem" | "financialAccount" | "bill";

interface BlobRow {
  id: string;
  ciphertext: string;
  iv: string;
}

// The narrow surface of a Prisma delegate this factory uses. Prisma's
// generated delegates each satisfy this shape; the `as unknown as` bridge
// below sidesteps the union-of-overloads typing without resorting to `any`.
interface BlobDelegate {
  findMany(args: {
    where: { userId: string };
    orderBy: { createdAt: "desc" };
    select: { id: true; ciphertext: true; iv: true };
  }): Promise<BlobRow[]>;
  create(args: {
    data: { userId: string; ciphertext: string; iv: string };
    select: { id: true };
  }): Promise<{ id: string }>;
}

async function requireUser(): Promise<string | null> {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  return getSessionUserId(sid);
}

export function createEncryptedRecordRoute(opts: { model: RecordModel; listKey: string }) {
  const delegate = ((): BlobDelegate => {
    switch (opts.model) {
      case "vaultItem":
        return prisma.vaultItem as unknown as BlobDelegate;
      case "financialAccount":
        return prisma.financialAccount as unknown as BlobDelegate;
      case "bill":
        return prisma.bill as unknown as BlobDelegate;
    }
  })();

  async function GET() {
    const userId = await requireUser();
    if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const rows = await delegate.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, ciphertext: true, iv: true },
    });
    return NextResponse.json({ [opts.listKey]: rows });
  }

  async function POST(req: Request) {
    const userId = await requireUser();
    if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = await readJsonBody(req);
    if (body instanceof NextResponse) return body;
    const ciphertext = typeof body.ciphertext === "string" ? body.ciphertext : "";
    const iv = typeof body.iv === "string" ? body.iv : "";
    if (!ciphertext || !iv) {
      return NextResponse.json({ error: "Missing fields." }, { status: 400 });
    }

    const created = await delegate.create({
      data: { userId, ciphertext, iv },
      select: { id: true },
    });
    return NextResponse.json({ id: created.id }, { status: 201 });
  }

  return { GET, POST };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/encrypted-record-route.test.ts`
Expected: PASS (5 passing).

- [ ] **Step 5: Rewire the three route files**

Replace the entire contents of each:

`src/app/api/vault/route.ts`:
```ts
import { createEncryptedRecordRoute } from "@/lib/encrypted-record-route";

export const { GET, POST } = createEncryptedRecordRoute({ model: "vaultItem", listKey: "items" });
```

`src/app/api/accounts/route.ts`:
```ts
import { createEncryptedRecordRoute } from "@/lib/encrypted-record-route";

export const { GET, POST } = createEncryptedRecordRoute({
  model: "financialAccount",
  listKey: "accounts",
});
```

`src/app/api/bills/route.ts`:
```ts
import { createEncryptedRecordRoute } from "@/lib/encrypted-record-route";

export const { GET, POST } = createEncryptedRecordRoute({ model: "bill", listKey: "bills" });
```

- [ ] **Step 6: Verify gates + behavior preservation**

Run: `npx tsc --noEmit` → no errors.
Run: `npm run build` → succeeds; `/api/vault`, `/api/accounts`, `/api/bills` all present.
Run (with `npm run dev` running against the dev DB): `npx vitest run --config vitest.e2e.config.ts` → **3/3 passing** (this directly exercises all three rewired routes and is the behavior-preservation proof; if `/api/*` 404s, clear `.next` and restart dev first).

- [ ] **Step 7: Commit**

```bash
git add src/lib/encrypted-record-route.ts src/lib/encrypted-record-route.test.ts src/app/api/vault/route.ts src/app/api/accounts/route.ts src/app/api/bills/route.ts
git commit -m "refactor: extract createEncryptedRecordRoute; rewire vault/accounts/bills routes"
```

---

### Task 2: `useEncryptedRecords` hook + generic api-client + migrate vault page

**Files:**
- Create: `src/app/providers/useEncryptedRecords.ts`
- Modify: `src/lib/api-client.ts` (add `listRecords`/`addRecord`; remove `listVault`/`addVaultItem`)
- Modify: `src/app/vault/page.tsx` (consume the hook)

**Interfaces:**
- Consumes: `api.listRecords`/`api.addRecord` (this task), `useKey` (`@/app/providers/KeyProvider`), `encryptItem`/`decryptItem` (`@/lib/crypto`).
- Produces:
  - `interface EncryptedRecordItem<T> { id: string; value: T | null }`
  - `useEncryptedRecords<T>(opts: { resource: string; listKey: string; serialize: (v: T) => string; parse: (json: string) => T; noun: string; saveError?: string }): { items: EncryptedRecordItem<T>[]; error: string; loaded: boolean; add: (value: T) => Promise<boolean>; masterKey: <KeyProvider key type> | null }`
  - `api.listRecords(resource: string): Promise<Record<string, unknown>>`
  - `api.addRecord(resource: string, ciphertext: string, iv: string): Promise<{ id: string }>`

- [ ] **Step 1: Add generic api-client methods, remove the vault-named pair**

In `src/lib/api-client.ts`: delete the `listVault` and `addVaultItem` properties, and add this generic pair to the `api` object (leave `listAccounts`/`addAccount`/`listBills`/`addBill` and the auth methods for now — later tasks remove the others):

```ts
  listRecords: async (resource: string) => {
    const res = await fetch(`/api/${resource}`);
    if (!res.ok) throw new Error("We couldn't load your data.");
    return res.json() as Promise<Record<string, unknown>>;
  },
  addRecord: (resource: string, ciphertext: string, iv: string) =>
    post<{ id: string }>(`/api/${resource}`, { ciphertext, iv }),
```

- [ ] **Step 2: Create the hook**

Create `src/app/providers/useEncryptedRecords.ts`:

```ts
"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { useKey } from "@/app/providers/KeyProvider";
import { encryptItem, decryptItem } from "@/lib/crypto";

export interface EncryptedRecordItem<T> {
  id: string;
  value: T | null; // null = this row failed to decrypt
}

interface EncryptedRow {
  id: string;
  ciphertext: string;
  iv: string;
}

export function useEncryptedRecords<T>(opts: {
  resource: string;
  listKey: string;
  serialize: (value: T) => string;
  parse: (json: string) => T;
  noun: string;
  saveError?: string;
}) {
  const { resource, listKey, serialize, parse, noun } = opts;
  const saveError = opts.saveError ?? "We couldn't save that. Please try again.";
  const router = useRouter();
  const { masterKey } = useKey();
  const [items, setItems] = useState<EncryptedRecordItem<T>[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!masterKey) return;
    setError("");
    const data = await api.listRecords(resource);
    const rows = (data[listKey] ?? []) as EncryptedRow[];
    const decrypted = await Promise.all(
      rows.map(async (r) => {
        try {
          return { id: r.id, value: parse(await decryptItem(masterKey, r.ciphertext, r.iv)) };
        } catch {
          return { id: r.id, value: null };
        }
      }),
    );
    setItems(decrypted);
    setLoaded(true);
  }, [masterKey, resource, listKey, parse]);

  useEffect(() => {
    if (!masterKey) {
      router.replace("/unlock");
      return;
    }
    load().catch(() =>
      setError(`We couldn't load your ${noun}. Please try unlocking again.`),
    );
  }, [masterKey, load, router, noun]);

  const add = useCallback(
    async (value: T): Promise<boolean> => {
      if (!masterKey) return false;
      setError("");
      try {
        const { ciphertext, iv } = await encryptItem(masterKey, serialize(value));
        await api.addRecord(resource, ciphertext, iv);
        await load();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : saveError);
        return false;
      }
    },
    [masterKey, resource, serialize, load, saveError],
  );

  return { items, error, loaded, add, masterKey };
}
```

- [ ] **Step 3: Migrate the vault page**

Replace the entire contents of `src/app/vault/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { LegacyMark } from "@/components/Logo";
import { AppNav } from "@/components/AppNav";
import { useEncryptedRecords } from "@/app/providers/useEncryptedRecords";

export default function VaultPage() {
  const { items, error, loaded, add, masterKey } = useEncryptedRecords<string>({
    resource: "vault",
    listKey: "items",
    serialize: (s) => s,
    parse: (s) => s,
    noun: "vault",
    saveError: "Could not save.",
  });
  const [draft, setDraft] = useState("");

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    if (await add(draft.trim())) setDraft("");
  }

  if (!masterKey) return null;

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Your Vault</h1>
        <p className="subtle">Everything here is encrypted on your device.</p>
        <form className="row" onSubmit={onAdd}>
          <input
            value={draft}
            placeholder="Add a private note…"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit">Add</button>
        </form>
        {error && <p className="error">{error}</p>}
        {loaded && items.length === 0 && (
          <p className="subtle">Nothing yet. Add your first note.</p>
        )}
        {items.map((it) => (
          <div className="item" key={it.id}>
            {it.value ?? "We couldn't unlock this item."}
          </div>
        ))}
      </div>
    </main>
  );
}
```

> **Documented behavior-equivalent change (per spec §5):** the decrypt-failure message now renders from the `value === null` marker rather than being substituted as the item text. Same UX — calm message, rest of list still renders.

- [ ] **Step 4: Verify gates**

Run: `npx tsc --noEmit` → no errors (nothing references the removed `listVault`/`addVaultItem`).
Run: `npm run build` → succeeds; `/vault` present.
Run: `npm test` → full unit suite green (unchanged).

- [ ] **Step 5: Manual smoke (vault)**

With `npm run dev` running and logged in: open `/vault`, add a note, confirm it appears; reload, confirm it persists and decrypts; lock/sign out and confirm `/vault` redirects to `/unlock`.

- [ ] **Step 6: Commit**

```bash
git add src/app/providers/useEncryptedRecords.ts src/lib/api-client.ts src/app/vault/page.tsx
git commit -m "refactor: add useEncryptedRecords hook + generic api-client; migrate vault page"
```

---

### Task 3: Migrate the accounts page

**Files:**
- Modify: `src/app/accounts/page.tsx` (consume the hook)
- Modify: `src/lib/api-client.ts` (remove `listAccounts`/`addAccount`)

**Interfaces:**
- Consumes: `useEncryptedRecords` + `EncryptedRecordItem` (Task 2); `Account`/`AccountType`/`serializeAccount`/`parseAccount`/`maskAccountNumber` (`@/lib/account`).
- Produces: nothing new.

- [ ] **Step 1: Migrate the accounts page**

Replace the entire contents of `src/app/accounts/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { useEncryptedRecords } from "@/app/providers/useEncryptedRecords";
import {
  type Account,
  type AccountType,
  serializeAccount,
  parseAccount,
  maskAccountNumber,
} from "@/lib/account";

const TYPES: AccountType[] = ["Checking", "Savings", "Investment", "Retirement", "Other"];

const EMPTY: Account = {
  type: "Checking",
  institution: "",
  nickname: "",
  accountNumber: "",
  balance: "",
  notes: "",
};

export default function AccountsPage() {
  const { items, error, loaded, add, masterKey } = useEncryptedRecords<Account>({
    resource: "accounts",
    listKey: "accounts",
    serialize: serializeAccount,
    parse: parseAccount,
    noun: "accounts",
  });
  const [draft, setDraft] = useState<Account>(EMPTY);

  function set<K extends keyof Account>(key: K, value: Account[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.nickname.trim()) return;
    if (await add(draft)) setDraft(EMPTY);
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
            {it.value ? (
              <>
                <strong>{it.value.nickname || "Untitled account"}</strong>
                <div className="meta">
                  {it.value.type}
                  {it.value.institution ? ` · ${it.value.institution}` : ""}
                </div>
                {it.value.accountNumber && (
                  <div className="meta">{maskAccountNumber(it.value.accountNumber)}</div>
                )}
                {it.value.balance && <div className="meta">Balance: {it.value.balance}</div>}
                {it.value.notes && <div className="notes">{it.value.notes}</div>}
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

- [ ] **Step 2: Remove the account-named api-client methods**

In `src/lib/api-client.ts`, delete the `listAccounts` and `addAccount` properties.

- [ ] **Step 3: Verify gates**

Run: `npx tsc --noEmit` → no errors.
Run: `npm run build` → succeeds; `/accounts` present.
Run: `npm test` → full unit suite green.

- [ ] **Step 4: Manual smoke (accounts)**

With dev running + logged in: open `/accounts`, add an account, confirm the card shows nickname/type/masked number/balance/notes; reload, confirm persistence.

- [ ] **Step 5: Commit**

```bash
git add src/app/accounts/page.tsx src/lib/api-client.ts
git commit -m "refactor: migrate accounts page onto useEncryptedRecords"
```

---

### Task 4: Migrate the bills page

**Files:**
- Modify: `src/app/bills/page.tsx` (consume the hook)
- Modify: `src/lib/api-client.ts` (remove `listBills`/`addBill`)

**Interfaces:**
- Consumes: `useEncryptedRecords` (Task 2); `Bill`/`Frequency`/`BillCategory`/`serializeBill`/`parseBill`/`totalMonthly`/`formatMoney`/`sortByDueDate` (`@/lib/bill`).
- Produces: nothing new.

- [ ] **Step 1: Migrate the bills page**

Replace the entire contents of `src/app/bills/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { useEncryptedRecords } from "@/app/providers/useEncryptedRecords";
import {
  type Bill,
  type Frequency,
  type BillCategory,
  serializeBill,
  parseBill,
  totalMonthly,
  formatMoney,
  sortByDueDate,
} from "@/lib/bill";

const CATEGORIES: BillCategory[] = [
  "Utility",
  "Streaming",
  "Insurance",
  "Loan",
  "Subscription",
  "Other",
];

const FREQUENCIES: Frequency[] = ["Weekly", "Monthly", "Quarterly", "Annual", "One-time"];

const EMPTY: Bill = {
  name: "",
  category: "Utility",
  amount: "",
  frequency: "Monthly",
  nextDueDate: "",
  paymentMethod: "",
  autoPay: false,
  website: "",
  notes: "",
};

export default function BillsPage() {
  const { items, error, loaded, add, masterKey } = useEncryptedRecords<Bill>({
    resource: "bills",
    listKey: "bills",
    serialize: serializeBill,
    parse: parseBill,
    noun: "bills",
  });
  const [draft, setDraft] = useState<Bill>(EMPTY);

  function set<K extends keyof Bill>(key: K, value: Bill[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.name.trim()) return;
    if (await add(draft)) setDraft(EMPTY);
  }

  if (!masterKey) return null;

  const decryptedBills = items
    .map((it) => it.value)
    .filter((b): b is Bill => b !== null);
  const sorted = sortByDueDate(decryptedBills);

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Bills &amp; Subscriptions</h1>
        <p className="subtle">Each bill is encrypted on your device.</p>

        <form onSubmit={onAdd}>
          <label htmlFor="name">Name</label>
          <input
            id="name"
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            required
          />

          <label htmlFor="category">Category</label>
          <select
            id="category"
            value={draft.category}
            onChange={(e) => set("category", e.target.value as BillCategory)}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <label htmlFor="amount">Amount</label>
          <input
            id="amount"
            value={draft.amount}
            onChange={(e) => set("amount", e.target.value)}
          />

          <label htmlFor="frequency">Frequency</label>
          <select
            id="frequency"
            value={draft.frequency}
            onChange={(e) => set("frequency", e.target.value as Frequency)}
          >
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>

          <label htmlFor="nextDueDate">Next due date</label>
          <input
            id="nextDueDate"
            type="date"
            value={draft.nextDueDate}
            onChange={(e) => set("nextDueDate", e.target.value)}
          />

          <label htmlFor="paymentMethod">Payment method</label>
          <input
            id="paymentMethod"
            value={draft.paymentMethod}
            onChange={(e) => set("paymentMethod", e.target.value)}
          />

          <label className="checkrow">
            <input
              type="checkbox"
              checked={draft.autoPay}
              onChange={(e) => set("autoPay", e.target.checked)}
            />
            Auto-pay
          </label>

          <label htmlFor="website">Website</label>
          <input
            id="website"
            value={draft.website}
            onChange={(e) => set("website", e.target.value)}
          />

          <label htmlFor="notes">Notes</label>
          <textarea
            id="notes"
            value={draft.notes}
            onChange={(e) => set("notes", e.target.value)}
          />

          <button type="submit">Add bill</button>
        </form>

        {error && <p className="error">{error}</p>}

        {decryptedBills.length > 0 && (
          <p className="subtle">
            Estimated ~{formatMoney(totalMonthly(decryptedBills))}/mo across{" "}
            {decryptedBills.length} {decryptedBills.length === 1 ? "bill" : "bills"}
          </p>
        )}

        {loaded && items.length === 0 && (
          <p className="subtle">No bills yet. Add your first above.</p>
        )}

        {items.some((it) => it.value === null) && (
          <p className="subtle">We couldn&apos;t unlock some bills.</p>
        )}

        {sorted.map((b, i) => (
          <div className="item" key={i}>
            <strong>{b.name || "Untitled bill"}</strong>
            <div className="meta">
              {b.category} · {b.frequency}
              {b.nextDueDate ? ` · due ${b.nextDueDate}` : ""}
            </div>
            {b.amount && <div className="meta">Amount: {b.amount}</div>}
            {b.autoPay && <div className="meta">Auto-pay</div>}
            {b.paymentMethod && <div className="meta">{b.paymentMethod}</div>}
            {b.website && <div className="meta">{b.website}</div>}
            {b.notes && <div className="notes">{b.notes}</div>}
          </div>
        ))}
      </div>
    </main>
  );
}
```

> The `key={i}` on the sorted list and the aggregate "couldn't unlock some bills" notice are preserved exactly as the pre-refactor bills page had them (behavior-preserving; both are on the backlog, not this refactor's concern).

- [ ] **Step 2: Remove the bill-named api-client methods**

In `src/lib/api-client.ts`, delete the `listBills` and `addBill` properties. After this task, `api-client` should contain only the auth methods, `post`, `listRecords`, and `addRecord` — no per-type record methods.

- [ ] **Step 3: Verify gates**

Run: `npx tsc --noEmit` → no errors.
Run: `npm run build` → succeeds; `/bills` present.
Run: `npm test` → full unit suite green.

- [ ] **Step 4: Manual smoke (bills)**

With dev running + logged in: open `/bills`, add a bill, confirm the card, the due-date sort, and the "Estimated ~$X/mo" summary; reload, confirm persistence.

- [ ] **Step 5: Commit**

```bash
git add src/app/bills/page.tsx src/lib/api-client.ts
git commit -m "refactor: migrate bills page onto useEncryptedRecords"
```

---

### Task 5: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full unit suite**

Run: `npm test`
Expected: all green, including `src/lib/encrypted-record-route.test.ts` (5 new) and the existing `account`/`bill`/`crypto`/`auth` suites — **unchanged**.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit` → no errors.

- [ ] **Step 3: Production build**

Run: `npm run build` → succeeds; routes `/vault`, `/accounts`, `/bills` and `/api/vault`, `/api/accounts`, `/api/bills` all present.

- [ ] **Step 4: Live e2e (behavior-preservation proof)**

With `npm run dev` running against the dev DB:
Run: `npx vitest run --config vitest.e2e.config.ts`
Expected: **3/3 passing**, unchanged (proves the API contract — status codes, response keys, no-plaintext storage — is identical after the refactor).

- [ ] **Step 5: Manual smoke across all three pages**

Confirm add + reload + decrypt on `/vault`, `/accounts`, `/bills`, and the `/unlock` redirect when locked.

---

## Self-Review

**Spec coverage** (against `2026-06-29-legacy-encrypted-record-abstraction-design.md`):
- §3 `createEncryptedRecordRoute` (factory, typed model switch, preserved `listKey`, one-line routes) → Task 1 ✓
- §4 `useEncryptedRecords` hook + generic `listRecords`/`addRecord` api-client → Task 2 ✓
- §5 page migration, vault identity serialize/parse + null-marker change, accounts/bills keep presentation → Tasks 2, 3, 4 ✓
- §6 testing: existing suite unchanged + new factory unit tests + live e2e + smoke → Tasks 1, 5 ✓
- §7 global constraints (behavior-preserving, zero-knowledge, no `any`, typed model access, verbatim copy, no schema change) → Global Constraints + all tasks ✓
- §8 module boundaries → file structure across Tasks 1–4 ✓

**Placeholder scan:** none — every code step contains full content.

**Type consistency:** `createEncryptedRecordRoute({ model, listKey })` signature identical in Task 1 (def), the three route rewires, and the factory test. `useEncryptedRecords` opts (`resource, listKey, serialize, parse, noun, saveError?`) and returns (`items, error, loaded, add, masterKey`) identical in Task 2 (def) and Tasks 2/3/4 (consumers). `EncryptedRecordItem<T>.value` accessed as `it.value` in all three pages. `add` returns `Promise<boolean>`, consumed as `if (await add(...)) setDraft(...)` in all three. `api.listRecords`/`api.addRecord` defined in Task 2, consumed by the hook.

**Verbatim-copy check:** load-error message reproduced per page via `noun` ("your vault"/"your accounts"/"your bills"); vault's terser save fallback "Could not save." preserved via `saveError`; all other strings (headings, placeholders, empty states, decrypt-failure messages) copied verbatim from the originals. Only the spec-sanctioned vault null-marker rendering changes.

**Behavior-preservation check:** clear-draft-on-success-only is preserved by gating `setDraft` on `add()`'s boolean return (originals cleared the draft only inside the success path). Response keys, status codes, and the e2e assertions are untouched.
