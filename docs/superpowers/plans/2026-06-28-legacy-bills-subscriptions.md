# Bills & Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add zero-knowledge encrypted Bills & Subscriptions records (add + list) with a client-side due-date sort and an estimated monthly-cost summary, mirroring the Financial Accounts slice.

**Architecture:** Bills ride on the existing zero-knowledge foundation — no new crypto, auth, key, or session logic. A bill is a typed object serialized to JSON, encrypted in the browser with the existing `encryptItem`, and stored as an opaque `{ ciphertext, iv }` blob in a new parallel `Bill` table. The `/bills` page decrypts client-side, sorts by next due date, and shows a normalized monthly total. The shared encrypted-record abstraction is deliberately deferred to its own future slice.

**Tech Stack:** Next.js 16 (App Router, TS strict), Prisma 6 → Railway Postgres, browser WebCrypto (existing `@/lib/crypto`), Vitest 4.

## Global Constraints

- Zero-knowledge: passphrase / master key / plaintext never reach the server; server persists only ciphertext, IVs, and existing auth data.
- Reuse existing modules unchanged: `encryptItem`/`decryptItem` (`@/lib/crypto`), `KeyProvider`/`useKey` (`@/app/providers/KeyProvider`), `getSessionUserId` (`@/lib/auth`), `readJsonBody` (`@/lib/http`), `SESSION_COOKIE` (`@/lib/session-cookie`), `prisma` (`@/lib/db`).
- TypeScript strict; no `any` in committed code.
- Calm, supportive copy per the Legacy design system; `--alert` color for errors only.
- Migrations applied to BOTH dev (`.env`) and test (`.env.test`) databases.
- Test command: `npm test` (= `vitest run`). Unit tests live next to source as `*.test.ts`.
- Known gotcha: after adding the API route, if `/api/*` 404s in dev, clear `.next` and restart `npm run dev` (stale Turbopack cache).

---

### Task 1: Bill domain module (`src/lib/bill.ts`)

Pure, testable, no crypto/IO. This task is self-contained and has no dependencies on other tasks.

**Files:**
- Create: `src/lib/bill.ts`
- Test: `src/lib/bill.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Frequency = "Weekly" | "Monthly" | "Quarterly" | "Annual" | "One-time"`
  - `type BillCategory = "Utility" | "Streaming" | "Insurance" | "Loan" | "Subscription" | "Other"`
  - `interface Bill { name: string; category: BillCategory; amount: string; frequency: Frequency; nextDueDate: string; paymentMethod: string; autoPay: boolean; website: string; notes: string }`
  - `serializeBill(b: Bill): string`
  - `parseBill(json: string): Bill`
  - `monthlyAmount(b: Bill): number`
  - `totalMonthly(bills: Bill[]): number`
  - `formatMoney(n: number): string`
  - `sortByDueDate(bills: Bill[]): Bill[]`

- [ ] **Step 1: Write the failing test**

Create `src/lib/bill.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  serializeBill,
  parseBill,
  monthlyAmount,
  totalMonthly,
  formatMoney,
  sortByDueDate,
  type Bill,
} from "@/lib/bill";

const sample: Bill = {
  name: "Netflix",
  category: "Streaming",
  amount: "15.99",
  frequency: "Monthly",
  nextDueDate: "2026-07-04",
  paymentMethod: "Visa ••1234",
  autoPay: true,
  website: "netflix.com/account",
  notes: "Family plan",
};

function bill(partial: Partial<Bill>): Bill {
  return { ...sample, ...partial };
}

describe("bill domain", () => {
  it("round-trips through serialize/parse, preserving the autoPay boolean", () => {
    const back = parseBill(serializeBill(sample));
    expect(back).toEqual(sample);
    expect(back.autoPay).toBe(true);
  });

  it("normalizes each frequency to a monthly amount", () => {
    expect(monthlyAmount(bill({ amount: "12", frequency: "Monthly" }))).toBeCloseTo(12);
    expect(monthlyAmount(bill({ amount: "120", frequency: "Annual" }))).toBeCloseTo(10);
    expect(monthlyAmount(bill({ amount: "30", frequency: "Quarterly" }))).toBeCloseTo(10);
    expect(monthlyAmount(bill({ amount: "10", frequency: "Weekly" }))).toBeCloseTo(10 * 52 / 12);
    expect(monthlyAmount(bill({ amount: "500", frequency: "One-time" }))).toBe(0);
  });

  it("treats non-numeric or messy amounts defensively", () => {
    expect(monthlyAmount(bill({ amount: "", frequency: "Monthly" }))).toBe(0);
    expect(monthlyAmount(bill({ amount: "free", frequency: "Monthly" }))).toBe(0);
    expect(monthlyAmount(bill({ amount: "$1,200", frequency: "Annual" }))).toBeCloseTo(100);
  });

  it("sums monthly amounts across a mixed set, and is 0 for none", () => {
    const bills = [
      bill({ amount: "12", frequency: "Monthly" }),
      bill({ amount: "120", frequency: "Annual" }),
      bill({ amount: "999", frequency: "One-time" }),
    ];
    expect(totalMonthly(bills)).toBeCloseTo(22);
    expect(totalMonthly([])).toBe(0);
  });

  it("formats money to a whole dollar", () => {
    expect(formatMoney(247.4)).toBe("$247");
    expect(formatMoney(0)).toBe("$0");
  });

  it("sorts by due date ascending with blanks last, without mutating input", () => {
    const input = [
      bill({ name: "C", nextDueDate: "" }),
      bill({ name: "A", nextDueDate: "2026-07-01" }),
      bill({ name: "B", nextDueDate: "2026-08-15" }),
    ];
    const sorted = sortByDueDate(input);
    expect(sorted.map((b) => b.name)).toEqual(["A", "B", "C"]);
    expect(input.map((b) => b.name)).toEqual(["C", "A", "B"]); // input untouched
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/bill.test.ts`
Expected: FAIL — cannot resolve module `@/lib/bill`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/bill.ts`:

```ts
export type Frequency = "Weekly" | "Monthly" | "Quarterly" | "Annual" | "One-time";

export type BillCategory =
  | "Utility"
  | "Streaming"
  | "Insurance"
  | "Loan"
  | "Subscription"
  | "Other";

export interface Bill {
  name: string;
  category: BillCategory;
  amount: string;
  frequency: Frequency;
  nextDueDate: string; // "YYYY-MM-DD" or ""
  paymentMethod: string;
  autoPay: boolean;
  website: string;
  notes: string;
}

export function serializeBill(b: Bill): string {
  return JSON.stringify(b);
}

export function parseBill(json: string): Bill {
  return JSON.parse(json) as Bill;
}

// Parse a free-text amount defensively: drop currency symbols, spaces, and
// thousands separators, then parseFloat. Non-numeric / empty -> 0.
function parseAmount(amount: string): number {
  const cleaned = amount.replace(/[^0-9.]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function monthlyAmount(b: Bill): number {
  const value = parseAmount(b.amount);
  switch (b.frequency) {
    case "Weekly":
      return value * 52 / 12;
    case "Monthly":
      return value;
    case "Quarterly":
      return value / 3;
    case "Annual":
      return value / 12;
    case "One-time":
      return 0;
    default:
      return 0;
  }
}

export function totalMonthly(bills: Bill[]): number {
  return bills.reduce((sum, b) => sum + monthlyAmount(b), 0);
}

export function formatMoney(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

export function sortByDueDate(bills: Bill[]): Bill[] {
  return [...bills].sort((a, b) => {
    if (!a.nextDueDate) return b.nextDueDate ? 1 : 0;
    if (!b.nextDueDate) return -1;
    return a.nextDueDate < b.nextDueDate ? -1 : a.nextDueDate > b.nextDueDate ? 1 : 0;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/bill.test.ts`
Expected: PASS (6 passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/bill.ts src/lib/bill.test.ts
git commit -m "feat: add bill domain module (serialize/parse, monthly normalization, sort)"
```

---

### Task 2: Prisma `Bill` model + migration (both databases)

**Files:**
- Modify: `prisma/schema.prisma` (add `Bill` model; add `bills Bill[]` relation to `User`)
- Create: `prisma/migrations/<timestamp>_bills/migration.sql` (generated by Prisma)

**Interfaces:**
- Consumes: nothing.
- Produces: `prisma.bill` Prisma Client model with fields `{ id, userId, ciphertext, iv, createdAt }`; `user.bills` relation include.

- [ ] **Step 1: Add the relation field to `User`**

In `prisma/schema.prisma`, inside `model User`, add a line after `financialAccounts FinancialAccount[]`:

```prisma
  bills             Bill[]
```

- [ ] **Step 2: Add the `Bill` model**

Append to `prisma/schema.prisma` (mirrors `FinancialAccount`):

```prisma
model Bill {
  id         String   @id @default(cuid())
  userId     String
  ciphertext String
  iv         String
  createdAt  DateTime @default(now())
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

- [ ] **Step 3: Create and apply the migration to the DEV database**

Run: `npx prisma migrate dev --name bills`
Expected: creates `prisma/migrations/<timestamp>_bills/migration.sql`, applies it to the dev DB (`.env` `DATABASE_URL`), and regenerates Prisma Client. The generated SQL should create table `"Bill"` with a foreign key to `"User"` (same shape as the FinancialAccount migration).

- [ ] **Step 4: Apply the migration to the TEST database**

Run: `npx dotenv -e .env.test -- npx prisma migrate deploy`
Expected: "1 migration applied" (the new `_bills` migration) against the test DB (`.env.test` `DATABASE_URL`).

- [ ] **Step 5: Verify the schema typechecks**

Run: `npx tsc --noEmit`
Expected: no errors (Prisma Client now includes the `Bill` model and `user.bills`).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add Bill model and migration"
```

---

### Task 3: API route (`/api/bills`) + api-client methods

**Files:**
- Create: `src/app/api/bills/route.ts`
- Modify: `src/lib/api-client.ts` (add `listBills`, `addBill`)

**Interfaces:**
- Consumes: `prisma` (`@/lib/db`), `getSessionUserId` (`@/lib/auth`), `SESSION_COOKIE` (`@/lib/session-cookie`), `readJsonBody` (`@/lib/http`); `prisma.bill` from Task 2.
- Produces:
  - `GET /api/bills` → 200 `{ bills: { id: string; ciphertext: string; iv: string }[] }` (newest first) | 401
  - `POST /api/bills` body `{ ciphertext, iv }` → 201 `{ id: string }` | 400 | 401
  - `api.listBills(): Promise<{ bills: { id: string; ciphertext: string; iv: string }[] }>`
  - `api.addBill(ciphertext: string, iv: string): Promise<{ id: string }>`

- [ ] **Step 1: Create the route handler**

Create `src/app/api/bills/route.ts` (a literal parallel of `src/app/api/accounts/route.ts`):

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
  const bills = await prisma.bill.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, ciphertext: true, iv: true },
  });
  return NextResponse.json({ bills });
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

  const bill = await prisma.bill.create({
    data: { userId, ciphertext, iv },
    select: { id: true },
  });
  return NextResponse.json({ id: bill.id }, { status: 201 });
}
```

- [ ] **Step 2: Add api-client methods**

In `src/lib/api-client.ts`, add inside the `api` object (after `addAccount`):

```ts
  listBills: async () => {
    const res = await fetch("/api/bills");
    if (!res.ok) throw new Error("We couldn't load your bills.");
    return res.json() as Promise<{
      bills: { id: string; ciphertext: string; iv: string }[];
    }>;
  },
  addBill: (ciphertext: string, iv: string) =>
    post<{ id: string }>("/api/bills", { ciphertext, iv }),
```

- [ ] **Step 3: Verify it typechecks and builds**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run build`
Expected: build succeeds; `/api/bills` appears in the route list.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/bills/route.ts src/lib/api-client.ts
git commit -m "feat: add /api/bills route and api-client methods"
```

---

### Task 4: `/bills` page + AppNav link

**Files:**
- Create: `src/app/bills/page.tsx`
- Modify: `src/components/AppNav.tsx` (add the Bills link)
- Modify: `src/app/globals.css` (add `.checkrow` class for the auto-pay checkbox row)

**Interfaces:**
- Consumes: `useKey` (`@/app/providers/KeyProvider`), `AppNav` (`@/components/AppNav`), `LegacyMark` (`@/components/Logo`), `api.listBills`/`api.addBill` (Task 3), `encryptItem`/`decryptItem` (`@/lib/crypto`), and from Task 1: `Bill`, `Frequency`, `BillCategory`, `serializeBill`, `parseBill`, `totalMonthly`, `formatMoney`, `sortByDueDate`.
- Produces: the `/bills` route (client page); updated `AppNav` showing Vault · Accounts · Bills.

- [ ] **Step 1: Add the Bills link to AppNav**

In `src/components/AppNav.tsx`, add a third link inside `<div className="navlinks">`, after the Accounts link:

```tsx
        <Link href="/bills">Bills</Link>
```

- [ ] **Step 2: Add the `.checkrow` style**

The global `input { width: 100% }` and `label { display: block; text-transform: uppercase }` rules would stretch a bare checkbox full-width and render its label as tiny uppercase text. Add a small class so the auto-pay checkbox sits inline with normal-case text. Append to `src/app/globals.css`:

```css
/* Inline checkbox row (e.g. auto-pay) */
.checkrow {
  display: flex;
  align-items: center;
  gap: 8px;
  text-transform: none;
  letter-spacing: normal;
  font-family: var(--font-body);
  font-size: 0.95rem;
  color: var(--ink);
  margin: 16px 0 7px;
}
.checkrow input[type="checkbox"] {
  width: auto;
  margin: 0;
}
```

- [ ] **Step 3: Create the bills page**

Create `src/app/bills/page.tsx` (mirrors `src/app/accounts/page.tsx`, plus the due-date sort and monthly summary):

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

const FREQUENCIES: Frequency[] = [
  "Weekly",
  "Monthly",
  "Quarterly",
  "Annual",
  "One-time",
];

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
  const router = useRouter();
  const { masterKey } = useKey();
  const [items, setItems] = useState<{ id: string; bill: Bill | null }[]>([]);
  const [draft, setDraft] = useState<Bill>(EMPTY);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!masterKey) return;
    setError("");
    const { bills } = await api.listBills();
    const decrypted = await Promise.all(
      bills.map(async (b) => {
        try {
          const json = await decryptItem(masterKey, b.ciphertext, b.iv);
          return { id: b.id, bill: parseBill(json) };
        } catch {
          return { id: b.id, bill: null };
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
      setError("We couldn't load your bills. Please try unlocking again."),
    );
  }, [masterKey, load, router]);

  function set<K extends keyof Bill>(key: K, value: Bill[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!masterKey || !draft.name.trim()) return;
    setError("");
    try {
      const { ciphertext, iv } = await encryptItem(masterKey, serializeBill(draft));
      await api.addBill(ciphertext, iv);
      setDraft(EMPTY);
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "We couldn't save that. Please try again.",
      );
    }
  }

  if (!masterKey) return null;

  const decryptedBills = items
    .map((it) => it.bill)
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

        {items.some((it) => it.bill === null) && (
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

- [ ] **Step 4: Verify it typechecks and builds**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run build`
Expected: build succeeds; `/bills` appears in the route list.

- [ ] **Step 5: Commit**

```bash
git add src/app/bills/page.tsx src/components/AppNav.tsx src/app/globals.css
git commit -m "feat: add bills page (encrypted add + decrypted, due-sorted list with monthly total)"
```

---

### Task 5: Extend the live e2e round-trip

**Files:**
- Modify: `e2e.spec.ts` (add a third `it` block for bills)

**Interfaces:**
- Consumes: existing e2e helpers (`generateSalt`, `deriveMasterKey`, `deriveAuthVerifier`, `encryptItem`, `decryptItem`), `serializeBill`/`parseBill`/`type Bill` (Task 1), `prisma.bill` via `user.bills` include (Task 2), `/api/bills` (Task 3).
- Produces: a passing live e2e proving the encrypted bill round-trip and zero-knowledge storage.

> **Note:** this test runs against a LIVE dev server. Before running it: ensure `npm run dev` is running (dev DB), then run the single spec. It is not part of the default `npm test` unit run pattern but lives in the repo and is run explicitly.

- [ ] **Step 1: Import the bill helpers**

In `e2e.spec.ts`, extend the existing account import line:

```ts
import { serializeAccount, parseAccount, type Account } from "@/lib/account";
import { serializeBill, parseBill, type Bill } from "@/lib/bill";
```

- [ ] **Step 2: Add the bills round-trip test**

Add a new `it` block inside the `describe("walking skeleton (live)", ...)`, after the financial-account test:

```ts
  it("stores and reads back an encrypted bill", async () => {
    const bEmail = `e2e-bill-${Date.now()}@example.com`;
    const pass = "bill-passphrase-123";

    // register + login
    const salt = generateSalt();
    const mk = await deriveMasterKey(pass, salt);
    const av = await deriveAuthVerifier(mk, pass);
    await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: bEmail, salt, authVerifier: av }),
    });
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: bEmail, authVerifier: av }),
    });
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    // encrypt + store a bill
    const billRecord: Bill = {
      name: "Northern Electric",
      category: "Utility",
      amount: "142.50",
      frequency: "Monthly",
      nextDueDate: "2026-07-01",
      paymentMethod: "Visa ••1234",
      autoPay: true,
      website: "northern-electric.example.com",
      notes: "Budget billing plan",
    };
    const { ciphertext, iv } = await encryptItem(mk, serializeBill(billRecord));
    const add = await fetch(`${BASE}/api/bills`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ ciphertext, iv }),
    });
    expect(add.status).toBe(201);

    // list + decrypt
    const list = await fetch(`${BASE}/api/bills`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const { bills } = await list.json();
    expect(bills).toHaveLength(1);
    const back = parseBill(await decryptItem(mk, bills[0].ciphertext, bills[0].iv));
    expect(back).toEqual(billRecord);

    // zero-knowledge: stored row has no plaintext
    const user = await db.user.findUnique({
      where: { email: bEmail },
      include: { bills: true },
    });
    const stored = user!.bills[0];
    expect(stored.ciphertext).not.toContain("Northern Electric");
    expect(stored.ciphertext).not.toContain("142.50");

    // cleanup
    await db.user.delete({ where: { email: bEmail } });
  }, 60_000);
```

- [ ] **Step 3: Run the live e2e**

Ensure `npm run dev` is running against the dev DB, then:

Run: `npx vitest run e2e.spec.ts`
Expected: 3 passing (walking skeleton, financial account, bill).

- [ ] **Step 4: Commit**

```bash
git add e2e.spec.ts
git commit -m "test: extend e2e with encrypted bill round-trip"
```

---

### Task 6: Final verification gates

**Files:** none (verification only).

- [ ] **Step 1: Full unit suite**

Run: `npm test`
Expected: all unit tests green, including the new `src/lib/bill.test.ts`.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: build succeeds; both `/bills` (page) and `/api/bills` (route) listed.

- [ ] **Step 4: Manual smoke (optional but recommended)**

With `npm run dev` running: log in, open `/bills`, add a bill, confirm it appears in the list with the meta line and that the "Estimated ~$X/mo" summary renders; reload and confirm it persists and decrypts.

---

## Self-Review

**Spec coverage** (against `2026-06-28-legacy-bills-subscriptions-skeleton-design.md`):
- §3 Data model (`Bill` Prisma + migration both DBs) → Task 2 ✓
- §4 API (`GET`/`POST /api/bills`, api-client) → Task 3 ✓
- §5 Domain module (`bill.ts`: serialize/parse/monthlyAmount/totalMonthly/formatMoney/sortByDueDate) → Task 1 ✓
- §6 UI & nav (`/bills` page: form, due-sorted list, monthly summary; AppNav Bills link) → Task 4 ✓
- §7 Error handling (save failure, per-bill decrypt failure excluded from total, `/unlock` redirect, calm load-error) → Task 4 ✓
- §8 Testing (unit for each frequency + non-numeric + sort + round-trip; extend live e2e; tsc/build/test gates) → Tasks 1, 5, 6 ✓
- §9 Global constraints (reuse existing modules, strict TS, both DBs migrated) → Global Constraints + Tasks 2–4 ✓

**Placeholder scan:** none — every code step contains the full content.

**Type consistency:** `Bill`, `Frequency`, `BillCategory` and the six functions are named identically in Task 1 (definition), Task 4 (page consumption), and Task 5 (e2e). The route returns `{ bills }` (Task 3) and the page/e2e destructure `{ bills }` (Tasks 4, 5). The Prisma relation `user.bills` (Task 2) is used by the e2e include (Task 5).

**Note on one spec detail:** §6 lists the card meta line as "category · frequency · due {date}" and shows amount; the plan renders amount on its own meta line (`Amount: …`) for readability, consistent with the Accounts card style. Functionally equivalent; flagged for transparency.
