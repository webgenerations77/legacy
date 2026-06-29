# Loans / Mortgages Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Loans" encrypted-record type (mortgages, auto, student, personal, HELOC, other) as a thin instance of the shared encrypted-record abstraction.

**Architecture:** Mirror the existing Bills/Accounts slices exactly. A pure domain lib (`loan.ts`) handles the typed object + serialize/parse + money/sort helpers. A new Prisma `Loan` blob model + a one-line route built from `createEncryptedRecordRoute`. A bespoke page consumes `useEncryptedRecords<Loan>`. The server only ever stores `{ ciphertext, iv }`; all crypto stays client-side, preserving the zero-knowledge invariant.

**Tech Stack:** Next.js 16 (App Router, TS strict), Prisma 6 → Railway Postgres, WebCrypto via `src/lib/crypto.ts`, Vitest.

## Global Constraints

- **Zero-knowledge invariant:** server persists only `{ ciphertext, iv }`; the master key and plaintext never leave the browser. The new route uses `createEncryptedRecordRoute` and adds no plaintext handling.
- **Stable serialize/parse refs:** `serializeLoan`/`parseLoan` are module-level functions (never inline lambdas) — the hook holds them in refs but stability is the contract.
- **Domain libs are self-contained and pure:** `loan.ts` defines its own `formatMoney`/amount-parsing rather than cross-importing from `bill.ts`, matching the existing convention.
- **Migrations are committed files:** create under `prisma/migrations/` and apply to **both** dev (`.env`) and test (`.env.test`) DBs. Do not run migrations against any non-local environment without maintainer confirmation.
- **Typecheck gate:** Vitest does not type-check — always run `npx tsc --noEmit`.
- **TS strict, follow existing file style** (double quotes, 2-space indent, `"use client"` on pages).

---

### Task 1: Loan domain lib (`loan.ts`) + unit tests

**Files:**
- Create: `src/lib/loan.ts`
- Test: `src/lib/loan.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `type LoanKind = "Mortgage" | "Auto" | "Student" | "Personal" | "HELOC" | "Other"`
  - `interface Loan { kind: LoanKind; lender: string; nickname: string; accountNumber: string; originalAmount: string; currentBalance: string; interestRate: string; monthlyPayment: string; nextPaymentDate: string; payoffDate: string; notes: string }`
  - `serializeLoan(l: Loan): string`
  - `parseLoan(json: string): Loan`
  - `totalBalance(loans: Loan[]): number`
  - `totalMonthly(loans: Loan[]): number`
  - `formatMoney(n: number): string`
  - `sortByNextPaymentDate(loans: Loan[]): Loan[]`
  - `maskAccountNumber(value: string): string`

- [ ] **Step 1: Write the failing test**

Create `src/lib/loan.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  serializeLoan,
  parseLoan,
  totalBalance,
  totalMonthly,
  formatMoney,
  sortByNextPaymentDate,
  maskAccountNumber,
  type Loan,
} from "@/lib/loan";

const sample: Loan = {
  kind: "Mortgage",
  lender: "First National Bank",
  nickname: "Home",
  accountNumber: "987654321098",
  originalAmount: "350,000",
  currentBalance: "$312,400",
  interestRate: "6.25%",
  monthlyPayment: "2,150",
  nextPaymentDate: "2026-07-01",
  payoffDate: "2051-06-01",
  notes: "30-year fixed",
};

function loan(partial: Partial<Loan>): Loan {
  return { ...sample, ...partial };
}

describe("loan domain", () => {
  it("round-trips through serialize/parse, preserving every field", () => {
    expect(parseLoan(serializeLoan(sample))).toEqual(sample);
  });

  it("sums current balances across a mixed set, defensively; 0 for none", () => {
    const loans = [
      loan({ currentBalance: "$312,400" }),
      loan({ currentBalance: "18,000" }),
      loan({ currentBalance: "" }),
      loan({ currentBalance: "n/a" }),
    ];
    expect(totalBalance(loans)).toBeCloseTo(330400);
    expect(totalBalance([])).toBe(0);
  });

  it("sums monthly payments across a mixed set, defensively; 0 for none", () => {
    const loans = [
      loan({ monthlyPayment: "2,150" }),
      loan({ monthlyPayment: "$450.50" }),
      loan({ monthlyPayment: "" }),
    ];
    expect(totalMonthly(loans)).toBeCloseTo(2600.5);
    expect(totalMonthly([])).toBe(0);
  });

  it("formats money to a whole dollar with thousands separators", () => {
    expect(formatMoney(330400)).toBe("$330,400");
    expect(formatMoney(0)).toBe("$0");
    expect(formatMoney(2150.4)).toBe("$2,150");
  });

  it("sorts by next payment date ascending with blanks last, without mutating input", () => {
    const input = [
      loan({ nickname: "C", nextPaymentDate: "" }),
      loan({ nickname: "A", nextPaymentDate: "2026-07-01" }),
      loan({ nickname: "B", nextPaymentDate: "2026-08-15" }),
    ];
    const sorted = sortByNextPaymentDate(input);
    expect(sorted.map((l) => l.nickname)).toEqual(["A", "B", "C"]);
    expect(input.map((l) => l.nickname)).toEqual(["C", "A", "B"]); // input untouched
  });

  it("masks an account number to the last four digits", () => {
    expect(maskAccountNumber("987654321098")).toBe("••••1098");
    expect(maskAccountNumber("1098")).toBe("1098");
    expect(maskAccountNumber("")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/loan.test.ts`
Expected: FAIL — cannot resolve `@/lib/loan` (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/loan.ts`:

```ts
export type LoanKind =
  | "Mortgage"
  | "Auto"
  | "Student"
  | "Personal"
  | "HELOC"
  | "Other";

export interface Loan {
  kind: LoanKind;
  lender: string;
  nickname: string;
  accountNumber: string;
  originalAmount: string;
  currentBalance: string;
  interestRate: string;
  monthlyPayment: string;
  nextPaymentDate: string; // "YYYY-MM-DD" or ""
  payoffDate: string; // "YYYY-MM-DD" or ""
  notes: string;
}

export function serializeLoan(l: Loan): string {
  return JSON.stringify(l);
}

export function parseLoan(json: string): Loan {
  return JSON.parse(json) as Loan;
}

// Parse a free-text amount defensively: drop currency symbols, spaces, and
// thousands separators, then parseFloat. Non-numeric / empty -> 0.
function parseAmount(amount: string): number {
  const cleaned = amount.replace(/[^0-9.]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function totalBalance(loans: Loan[]): number {
  return loans.reduce((sum, l) => sum + parseAmount(l.currentBalance), 0);
}

export function totalMonthly(loans: Loan[]): number {
  return loans.reduce((sum, l) => sum + parseAmount(l.monthlyPayment), 0);
}

export function formatMoney(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

export function sortByNextPaymentDate(loans: Loan[]): Loan[] {
  return [...loans].sort((a, b) => {
    if (!a.nextPaymentDate) return b.nextPaymentDate ? 1 : 0;
    if (!b.nextPaymentDate) return -1;
    return a.nextPaymentDate < b.nextPaymentDate
      ? -1
      : a.nextPaymentDate > b.nextPaymentDate
        ? 1
        : 0;
  });
}

export function maskAccountNumber(value: string): string {
  if (value.length <= 4) return value;
  return "••••" + value.slice(-4);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/loan.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/loan.ts src/lib/loan.test.ts
git commit -m "feat: add loan domain lib (serialize/parse, totals, sort, mask)"
```

---

### Task 2: Prisma `Loan` model + migration + API route

**Files:**
- Modify: `prisma/schema.prisma` (add `Loan` model + `loans Loan[]` on `User`)
- Create: `prisma/migrations/<timestamp>_loans/migration.sql` (generated by Prisma)
- Modify: `src/lib/encrypted-record-route.ts:8` and `:36-46` (add `"loan"` to union + delegate switch)
- Create: `src/app/api/loans/route.ts`

**Interfaces:**
- Consumes: `createEncryptedRecordRoute({ model, listKey })` from `src/lib/encrypted-record-route.ts`.
- Produces: `GET`/`POST` handlers at `/api/loans`; `prisma.loan` blob delegate; `RecordModel` now includes `"loan"`.

- [ ] **Step 1: Add the Prisma model**

In `prisma/schema.prisma`, add `loans Loan[]` to the `User` model's relation list (alongside `bills Bill[]`):

```prisma
model User {
  id               String      @id @default(cuid())
  email            String      @unique
  kdfSalt          String
  authVerifierHash String
  createdAt        DateTime    @default(now())
  sessions          Session[]
  vaultItems        VaultItem[]
  financialAccounts FinancialAccount[]
  bills             Bill[]
  loans             Loan[]
}
```

Then append a new model at the end of the file:

```prisma
model Loan {
  id         String   @id @default(cuid())
  userId     String
  ciphertext String
  iv         String
  createdAt  DateTime @default(now())
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

- [ ] **Step 2: Create + apply the migration on the dev DB**

The default `DATABASE_URL` (`.env`) points at the dev DB. Run:

Run: `npx prisma migrate dev --name loans`
Expected: creates `prisma/migrations/<timestamp>_loans/migration.sql`, applies it to the dev DB, and regenerates the Prisma client. The generated SQL should match:

```sql
-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Apply the same migration to the test DB**

Run: `npx dotenv -e .env.test -- npx prisma migrate deploy`
Expected: "1 migration applied" (the `_loans` migration) against the test DB; no schema drift.

> If `prisma migrate deploy` reports the test DB is missing earlier migrations, apply the full history (it deploys all pending migrations in order) — that is expected and safe for the local test instance.

- [ ] **Step 4: Register the model in the route factory**

In `src/lib/encrypted-record-route.ts`, extend the union (line 8):

```ts
type RecordModel = "vaultItem" | "financialAccount" | "bill" | "loan";
```

And add a case to the delegate switch (inside `createEncryptedRecordRoute`, after the `"bill"` case):

```ts
      case "bill":
        return prisma.bill as unknown as BlobDelegate;
      case "loan":
        return prisma.loan as unknown as BlobDelegate;
```

- [ ] **Step 5: Create the route**

Create `src/app/api/loans/route.ts`:

```ts
import { createEncryptedRecordRoute } from "@/lib/encrypted-record-route";

export const { GET, POST } = createEncryptedRecordRoute({ model: "loan", listKey: "loans" });
```

- [ ] **Step 6: Verify existing route + domain tests still pass and types are clean**

Run: `npx vitest run src/lib/encrypted-record-route.test.ts src/lib/loan.test.ts`
Expected: PASS (the factory test is model-agnostic; adding `"loan"` does not change it).

Run: `npx tsc --noEmit`
Expected: no errors (`prisma.loan` now exists on the regenerated client).

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/encrypted-record-route.ts src/app/api/loans/route.ts
git commit -m "feat: add Loan prisma model, migration, and /api/loans route"
```

---

### Task 3: Loans page + nav link

**Files:**
- Create: `src/app/loans/page.tsx`
- Modify: `src/components/AppNav.tsx:25-27` (add Loans link)

**Interfaces:**
- Consumes: `useEncryptedRecords<Loan>` from `src/app/providers/useEncryptedRecords.ts`; `Loan`, `LoanKind`, `serializeLoan`, `parseLoan`, `totalBalance`, `totalMonthly`, `formatMoney`, `sortByNextPaymentDate`, `maskAccountNumber` from `src/lib/loan.ts`; `AppNav`, `LegacyMark`.
- Produces: the `/loans` route (a client page); a nav link to it.

- [ ] **Step 1: Add the nav link**

In `src/components/AppNav.tsx`, add a Loans link after Bills:

```tsx
      <div className="navlinks">
        <Link href="/vault">Vault</Link>
        <Link href="/accounts">Accounts</Link>
        <Link href="/bills">Bills</Link>
        <Link href="/loans">Loans</Link>
      </div>
```

- [ ] **Step 2: Create the page**

Create `src/app/loans/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { useEncryptedRecords } from "@/app/providers/useEncryptedRecords";
import {
  type Loan,
  type LoanKind,
  serializeLoan,
  parseLoan,
  totalBalance,
  totalMonthly,
  formatMoney,
  sortByNextPaymentDate,
  maskAccountNumber,
} from "@/lib/loan";

const KINDS: LoanKind[] = ["Mortgage", "Auto", "Student", "Personal", "HELOC", "Other"];

const EMPTY: Loan = {
  kind: "Mortgage",
  lender: "",
  nickname: "",
  accountNumber: "",
  originalAmount: "",
  currentBalance: "",
  interestRate: "",
  monthlyPayment: "",
  nextPaymentDate: "",
  payoffDate: "",
  notes: "",
};

export default function LoansPage() {
  const { items, error, loaded, add, masterKey } = useEncryptedRecords<Loan>({
    resource: "loans",
    listKey: "loans",
    serialize: serializeLoan,
    parse: parseLoan,
    noun: "loans",
  });
  const [draft, setDraft] = useState<Loan>(EMPTY);

  function set<K extends keyof Loan>(key: K, value: Loan[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.lender.trim() && !draft.nickname.trim()) return;
    if (await add(draft)) setDraft(EMPTY);
  }

  if (!masterKey) return null;

  const decryptedLoans = items
    .map((it) => it.value)
    .filter((l): l is Loan => l !== null);
  const sorted = sortByNextPaymentDate(decryptedLoans);

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Loans &amp; Mortgages</h1>
        <p className="subtle">Each loan is encrypted on your device.</p>

        <form onSubmit={onAdd}>
          <label htmlFor="kind">Type</label>
          <select
            id="kind"
            value={draft.kind}
            onChange={(e) => set("kind", e.target.value as LoanKind)}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>

          <label htmlFor="lender">Lender</label>
          <input
            id="lender"
            value={draft.lender}
            onChange={(e) => set("lender", e.target.value)}
          />

          <label htmlFor="nickname">Nickname</label>
          <input
            id="nickname"
            value={draft.nickname}
            onChange={(e) => set("nickname", e.target.value)}
          />

          <label htmlFor="accountNumber">Account number</label>
          <input
            id="accountNumber"
            value={draft.accountNumber}
            onChange={(e) => set("accountNumber", e.target.value)}
          />

          <label htmlFor="originalAmount">Original amount</label>
          <input
            id="originalAmount"
            value={draft.originalAmount}
            onChange={(e) => set("originalAmount", e.target.value)}
          />

          <label htmlFor="currentBalance">Current balance</label>
          <input
            id="currentBalance"
            value={draft.currentBalance}
            onChange={(e) => set("currentBalance", e.target.value)}
          />

          <label htmlFor="interestRate">Interest rate (APR)</label>
          <input
            id="interestRate"
            value={draft.interestRate}
            onChange={(e) => set("interestRate", e.target.value)}
          />

          <label htmlFor="monthlyPayment">Monthly payment</label>
          <input
            id="monthlyPayment"
            value={draft.monthlyPayment}
            onChange={(e) => set("monthlyPayment", e.target.value)}
          />

          <label htmlFor="nextPaymentDate">Next payment date</label>
          <input
            id="nextPaymentDate"
            type="date"
            value={draft.nextPaymentDate}
            onChange={(e) => set("nextPaymentDate", e.target.value)}
          />

          <label htmlFor="payoffDate">Payoff date</label>
          <input
            id="payoffDate"
            type="date"
            value={draft.payoffDate}
            onChange={(e) => set("payoffDate", e.target.value)}
          />

          <label htmlFor="notes">Notes</label>
          <textarea
            id="notes"
            value={draft.notes}
            onChange={(e) => set("notes", e.target.value)}
          />

          <button type="submit">Add loan</button>
        </form>

        {error && <p className="error">{error}</p>}

        {decryptedLoans.length > 0 && (
          <p className="subtle">
            ~{formatMoney(totalBalance(decryptedLoans))} owed across{" "}
            {decryptedLoans.length} {decryptedLoans.length === 1 ? "loan" : "loans"} ·
            ~{formatMoney(totalMonthly(decryptedLoans))}/mo in payments
          </p>
        )}

        {loaded && items.length === 0 && (
          <p className="subtle">No loans yet. Add your first above.</p>
        )}

        {items.some((it) => it.value === null) && (
          <p className="subtle">We couldn&apos;t unlock some loans.</p>
        )}

        {sorted.map((l, i) => (
          <div className="item" key={i}>
            <strong>{l.nickname || l.lender || "Untitled loan"}</strong>
            <div className="meta">
              {l.kind}
              {l.lender ? ` · ${l.lender}` : ""}
            </div>
            {l.accountNumber && (
              <div className="meta">{maskAccountNumber(l.accountNumber)}</div>
            )}
            {l.currentBalance && <div className="meta">Balance: {l.currentBalance}</div>}
            {l.interestRate && <div className="meta">Rate: {l.interestRate}</div>}
            {l.monthlyPayment && <div className="meta">Payment: {l.monthlyPayment}/mo</div>}
            {l.nextPaymentDate && <div className="meta">Next: {l.nextPaymentDate}</div>}
            {l.payoffDate && <div className="meta">Payoff: {l.payoffDate}</div>}
            {l.notes && <div className="notes">{l.notes}</div>}
          </div>
        ))}
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Build gate**

Run: `npm run build`
Expected: build succeeds; `/loans` appears in the route list.

> If `/api/*` 404s under Turbopack dev afterward, stop the dev server, delete `.next` (Windows: server must be stopped first or you get EPERM), and restart.

- [ ] **Step 5: Commit**

```bash
git add src/app/loans/page.tsx src/components/AppNav.tsx
git commit -m "feat: add loans page and nav link"
```

---

### Task 4: Live e2e coverage for loans + full verification

**Files:**
- Modify: `e2e.spec.ts` (add a loans round-trip test; import loan helpers)

**Interfaces:**
- Consumes: `serializeLoan`, `parseLoan`, `type Loan` from `src/lib/loan.ts`; existing crypto + fetch helpers in `e2e.spec.ts`.
- Produces: a third record-type e2e test proving the loans round-trip + no-plaintext storage.

- [ ] **Step 1: Add the loan import**

In `e2e.spec.ts`, after the bill import (line 17), add:

```ts
import { serializeLoan, parseLoan, type Loan } from "@/lib/loan";
```

- [ ] **Step 2: Add the loans test**

Inside the `describe("walking skeleton (live)", ...)` block, after the bill test (before the closing `})` of the describe), add:

```ts
  it("stores and reads back an encrypted loan", async () => {
    const lEmail = `e2e-loan-${Date.now()}@example.com`;
    const pass = "loan-passphrase-123";

    // register + login
    const salt = generateSalt();
    const mk = await deriveMasterKey(pass, salt);
    const av = await deriveAuthVerifier(mk, pass);
    await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: lEmail, salt, authVerifier: av }),
    });
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: lEmail, authVerifier: av }),
    });
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    // encrypt + store a loan
    const loanRecord: Loan = {
      kind: "Mortgage",
      lender: "First National Bank",
      nickname: "Home",
      accountNumber: "987654321098",
      originalAmount: "350,000",
      currentBalance: "312,400",
      interestRate: "6.25%",
      monthlyPayment: "2,150",
      nextPaymentDate: "2026-07-01",
      payoffDate: "2051-06-01",
      notes: "30-year fixed",
    };
    const { ciphertext, iv } = await encryptItem(mk, serializeLoan(loanRecord));
    const add = await fetch(`${BASE}/api/loans`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ ciphertext, iv }),
    });
    expect(add.status).toBe(201);

    // list + decrypt
    const list = await fetch(`${BASE}/api/loans`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const { loans } = await list.json();
    expect(loans).toHaveLength(1);
    const back = parseLoan(await decryptItem(mk, loans[0].ciphertext, loans[0].iv));
    expect(back).toEqual(loanRecord);

    // zero-knowledge: stored row has no plaintext
    const user = await db.user.findUnique({
      where: { email: lEmail },
      include: { loans: true },
    });
    const stored = user!.loans[0];
    expect(stored.ciphertext).not.toContain("First National");
    expect(stored.ciphertext).not.toContain("987654321098");

    // cleanup
    await db.user.delete({ where: { email: lEmail } });
  }, 60_000);
```

- [ ] **Step 3: Run the full unit suite + typecheck**

Run: `npm test`
Expected: all suites green (including `loan.test.ts`).

Run: `npx tsc --noEmit`
Expected: no errors (`user.loans` now exists on the Prisma include type).

- [ ] **Step 4: Run the live e2e (requires a running dev server + dev DB)**

In one terminal: `npm run dev`
In another:

Run: `npx vitest run --config vitest.e2e.config.ts`
Expected: all e2e tests pass, including "stores and reads back an encrypted loan" — proving the full zero-knowledge round-trip and no-plaintext storage for loans.

> The e2e config is not part of `npm test`. If the dev server isn't running, the test fails with connection errors — start it first.

- [ ] **Step 5: Commit**

```bash
git add e2e.spec.ts
git commit -m "test: add live e2e loan round-trip + no-plaintext check"
```

---

## Self-Review

**Spec coverage:**
- Domain lib `loan.ts` + helpers + tests → Task 1. ✓
- Prisma `Loan` model + migration (both DBs) → Task 2 (Steps 1-3). ✓
- Route one-liner + `RecordModel` registration → Task 2 (Steps 4-5). ✓
- Page consuming `useEncryptedRecords<Loan>` with both summary lines + sorted cards → Task 3. ✓
- Nav link → Task 3 (Step 1). ✓
- Unit tests (round-trip, defensive parsing, totals, sort/no-mutate, mask) → Task 1 test. ✓
- Verification gates (`npm test`, `tsc`, `build`, live e2e) → distributed across Tasks 1-4; full gauntlet in Task 4. ✓
- Zero-knowledge preserved (server stores only `{ciphertext, iv}`; e2e asserts no plaintext) → Task 2 (factory) + Task 4 e2e. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to" — every code step shows full content. ✓

**Type consistency:** `Loan` field names and helper signatures are identical across Task 1 (definition), Task 3 (page consumption), and Task 4 (e2e). `model: "loan"` / `listKey: "loans"` / `resource: "loans"` consistent across Tasks 2-4. `prisma.loan` (Task 2) matches `user.loans` include (Task 4) and `loans Loan[]` relation (Task 2). ✓
