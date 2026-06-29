# Legacy Readiness Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a vault-gated `/readiness` page that shows a single importance-weighted 0–100 "Legacy readiness" score over the six record categories, with per-category status, next-step suggestions, and a persisted "Nothing to add" acknowledgment.

**Architecture:** A pure scoring lib (`src/lib/readiness.ts`) computes the report from already-decrypted records. A new encrypted singleton (`ReadinessState` table + `/api/readiness/state` route) persists the per-category "nothing to add" flags as an opaque `{ciphertext, iv}` blob — the master key encrypts/decrypts it in-browser, so zero-knowledge holds. A `useReadinessData` hook does all IO (parallel load, decrypt, compute, toggle-and-save); the page renders the report.

**Tech Stack:** Next.js 16 (App Router, TS strict), Prisma 6 → Railway Postgres, browser WebCrypto (AES-GCM via `src/lib/crypto.ts`), Vitest.

## Global Constraints

- **Zero-knowledge invariant:** the server stores only `{ciphertext, iv}` for the acknowledgment; plaintext and the master key never leave the browser. The readiness page decrypts records in-browser only. No new plaintext user data on the server.
- **TS strict** — no `any`; use the `as unknown as` bridge pattern already used in `encrypted-record-route.ts` only where unavoidable.
- **Migrations are committed files** under `prisma/migrations/`; apply to **both** the dev (`.env`) and test (`.env.test`) DBs. Do not run `prisma migrate` against non-local environments without confirming with the maintainer.
- **Verification gates** (run before declaring any task done where applicable): `npm test`, `npx tsc --noEmit`, `npm run build`.
- **Domain libs are pure** and unit-tested with `*.test.ts` next to source.
- Use the existing calm brand styling / CSS classes; match the structure of the other record pages.

---

### Task 1: Pure readiness scoring lib (`src/lib/readiness.ts`)

**Files:**
- Create: `src/lib/readiness.ts`
- Test: `src/lib/readiness.test.ts`

**Interfaces:**
- Consumes: `Account` (`@/lib/account`), `Bill` (`@/lib/bill`), `Loan` (`@/lib/loan`), `Beneficiary` + `totalAllocation` + `allocationStatus` (`@/lib/beneficiary`).
- Produces (relied on by Tasks 3, 4, 5, 6):
  - `type ReadinessCategoryKey = "accounts" | "beneficiaries" | "loans" | "bills" | "obituary" | "vault"`
  - `interface ReadinessState { acknowledgedEmpty: ReadinessCategoryKey[] }`
  - `interface ReadinessInput { accounts: Account[]; bills: Bill[]; loans: Loan[]; beneficiaries: Beneficiary[]; vaultCount: number; obituaryDraftPresent: boolean; acknowledgedEmpty: ReadinessCategoryKey[] }`
  - `interface ReadinessCategory { key: ReadinessCategoryKey; label: string; weight: number; score: number; status: "complete" | "attention" | "empty"; acknowledged: boolean; suggestion?: string }`
  - `interface ReadinessReport { overall: number; completeCount: number; categories: ReadinessCategory[] }`
  - `function computeReadiness(input: ReadinessInput): ReadinessReport`
  - `function serializeReadinessState(state: ReadinessState): string`
  - `function parseReadinessState(json: string): ReadinessState`
  - `const CATEGORY_WEIGHTS: Record<ReadinessCategoryKey, number>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/readiness.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  computeReadiness,
  serializeReadinessState,
  parseReadinessState,
  CATEGORY_WEIGHTS,
  type ReadinessInput,
  type ReadinessCategoryKey,
} from "@/lib/readiness";
import type { Account } from "@/lib/account";
import type { Bill } from "@/lib/bill";
import type { Loan } from "@/lib/loan";
import type { Beneficiary } from "@/lib/beneficiary";

const account: Account = {
  type: "Savings",
  institution: "First National",
  nickname: "Rainy day",
  accountNumber: "123456784821",
  balance: "12,500",
  notes: "",
};
const bill: Bill = {
  name: "Electric",
  category: "Utility",
  amount: "100",
  frequency: "Monthly",
  nextDueDate: "2026-07-01",
  paymentMethod: "Visa",
  autoPay: true,
  website: "",
  notes: "",
};
const loan: Loan = {
  kind: "Mortgage",
  lender: "First National",
  nickname: "Home",
  accountNumber: "987654321098",
  originalAmount: "350000",
  currentBalance: "312400",
  interestRate: "6.25",
  monthlyPayment: "2150",
  nextPaymentDate: "2026-07-01",
  payoffDate: "2051-06-01",
  notes: "",
};
function bene(allocation: string): Beneficiary {
  return {
    fullName: "Jane Doe",
    relationship: "Spouse",
    email: "",
    phone: "",
    mailingAddress: "",
    allocation,
    notes: "",
  };
}

const EMPTY: ReadinessInput = {
  accounts: [],
  bills: [],
  loans: [],
  beneficiaries: [],
  vaultCount: 0,
  obituaryDraftPresent: false,
  acknowledgedEmpty: [],
};

function cat(input: ReadinessInput, key: ReadinessCategoryKey) {
  return computeReadiness(input).categories.find((c) => c.key === key)!;
}

describe("computeReadiness", () => {
  it("scores an empty profile at 0 with every category 'empty'", () => {
    const report = computeReadiness(EMPTY);
    expect(report.overall).toBe(0);
    expect(report.completeCount).toBe(0);
    expect(report.categories).toHaveLength(6);
    expect(report.categories.every((c) => c.status === "empty")).toBe(true);
    expect(report.categories.every((c) => c.score === 0)).toBe(true);
  });

  it("scores a fully-populated, balanced profile at 100", () => {
    const report = computeReadiness({
      accounts: [account],
      bills: [bill],
      loans: [loan],
      beneficiaries: [bene("100")],
      vaultCount: 1,
      obituaryDraftPresent: true,
      acknowledgedEmpty: [],
    });
    expect(report.overall).toBe(100);
    expect(report.completeCount).toBe(6);
    expect(report.categories.every((c) => c.status === "complete")).toBe(true);
  });

  it("gives beneficiaries a partial 'attention' score when present but unbalanced", () => {
    const c = cat({ ...EMPTY, beneficiaries: [bene("50")] }, "beneficiaries");
    expect(c.score).toBe(60);
    expect(c.status).toBe("attention");
    expect(c.suggestion).toContain("50%");
  });

  it("awards full beneficiary credit only when allocations balance to 100%", () => {
    const c = cat({ ...EMPTY, beneficiaries: [bene("60"), bene("40")] }, "beneficiaries");
    expect(c.score).toBe(100);
    expect(c.status).toBe("complete");
    expect(c.suggestion).toBeUndefined();
  });

  it("weights each category by importance (only accounts present -> 25)", () => {
    expect(computeReadiness({ ...EMPTY, accounts: [account] }).overall).toBe(25);
    expect(computeReadiness({ ...EMPTY, loans: [loan] }).overall).toBe(15);
    expect(computeReadiness({ ...EMPTY, vaultCount: 1 }).overall).toBe(10);
  });

  it("treats an acknowledged-empty category as complete and lifts the overall", () => {
    const report = computeReadiness({ ...EMPTY, acknowledgedEmpty: ["loans"] });
    const loans = report.categories.find((c) => c.key === "loans")!;
    expect(loans.score).toBe(100);
    expect(loans.status).toBe("complete");
    expect(loans.acknowledged).toBe(true);
    expect(loans.suggestion).toBeUndefined();
    expect(report.overall).toBe(15);
  });

  it("exposes weights that sum to 100", () => {
    const sum = Object.values(CATEGORY_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });
});

describe("readiness state serialization", () => {
  it("round-trips acknowledgedEmpty", () => {
    const state = { acknowledgedEmpty: ["loans", "bills"] as ReadinessCategoryKey[] };
    expect(parseReadinessState(serializeReadinessState(state))).toEqual(state);
  });

  it("returns an empty list on malformed or unknown input", () => {
    expect(parseReadinessState("not json")).toEqual({ acknowledgedEmpty: [] });
    expect(parseReadinessState("{}")).toEqual({ acknowledgedEmpty: [] });
    expect(parseReadinessState('{"acknowledgedEmpty":["loans","bogus"]}')).toEqual({
      acknowledgedEmpty: ["loans"],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/readiness.test.ts`
Expected: FAIL — cannot find module `@/lib/readiness`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/readiness.ts`:

```ts
import { type Account } from "@/lib/account";
import { type Bill } from "@/lib/bill";
import { type Loan } from "@/lib/loan";
import {
  type Beneficiary,
  totalAllocation,
  allocationStatus,
} from "@/lib/beneficiary";

export type ReadinessCategoryKey =
  | "accounts"
  | "beneficiaries"
  | "loans"
  | "bills"
  | "obituary"
  | "vault";

const ORDER: ReadinessCategoryKey[] = [
  "accounts",
  "beneficiaries",
  "loans",
  "bills",
  "obituary",
  "vault",
];

export const CATEGORY_WEIGHTS: Record<ReadinessCategoryKey, number> = {
  accounts: 25,
  beneficiaries: 25,
  loans: 15,
  bills: 15,
  obituary: 10,
  vault: 10,
};

const CATEGORY_LABELS: Record<ReadinessCategoryKey, string> = {
  accounts: "Accounts",
  beneficiaries: "Beneficiaries",
  loans: "Loans",
  bills: "Bills",
  obituary: "Obituary",
  vault: "Vault",
};

export interface ReadinessState {
  acknowledgedEmpty: ReadinessCategoryKey[];
}

export interface ReadinessInput {
  accounts: Account[];
  bills: Bill[];
  loans: Loan[];
  beneficiaries: Beneficiary[];
  vaultCount: number;
  obituaryDraftPresent: boolean;
  acknowledgedEmpty: ReadinessCategoryKey[];
}

export interface ReadinessCategory {
  key: ReadinessCategoryKey;
  label: string;
  weight: number;
  score: number; // 0-100 sub-score
  status: "complete" | "attention" | "empty";
  acknowledged: boolean;
  suggestion?: string;
}

export interface ReadinessReport {
  overall: number; // 0-100 integer
  completeCount: number;
  categories: ReadinessCategory[];
}

// Present a percentage as a clean string: integers bare, otherwise 2 decimals.
function formatPercent(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// Record-only sub-score (before any "nothing to add" acknowledgment).
function rawScore(key: ReadinessCategoryKey, input: ReadinessInput): number {
  switch (key) {
    case "accounts":
      return input.accounts.length > 0 ? 100 : 0;
    case "beneficiaries": {
      if (input.beneficiaries.length === 0) return 0;
      const balanced =
        allocationStatus(totalAllocation(input.beneficiaries)) === "balanced";
      return balanced ? 100 : 60;
    }
    case "loans":
      return input.loans.length > 0 ? 100 : 0;
    case "bills":
      return input.bills.length > 0 ? 100 : 0;
    case "obituary":
      return input.obituaryDraftPresent ? 100 : 0;
    case "vault":
      return input.vaultCount > 0 ? 100 : 0;
  }
}

function suggestionFor(key: ReadinessCategoryKey, input: ReadinessInput): string {
  switch (key) {
    case "accounts":
      return "Add your financial accounts so survivors know what exists.";
    case "beneficiaries":
      if (input.beneficiaries.length === 0) return "Add at least one beneficiary.";
      return `Allocations total ${formatPercent(
        totalAllocation(input.beneficiaries),
      )}% — adjust to 100%.`;
    case "loans":
      return "Add your loans, or mark 'Nothing to add'.";
    case "bills":
      return "Add your recurring bills, or mark 'Nothing to add'.";
    case "obituary":
      return "Draft an obituary, or mark 'Nothing to add'.";
    case "vault":
      return "Save important notes to your vault, or mark 'Nothing to add'.";
  }
}

export function computeReadiness(input: ReadinessInput): ReadinessReport {
  const ack = new Set(input.acknowledgedEmpty);

  const categories = ORDER.map((key): ReadinessCategory => {
    const acknowledged = ack.has(key);
    const score = acknowledged ? 100 : rawScore(key, input);
    const status: ReadinessCategory["status"] =
      score === 100 ? "complete" : score === 0 ? "empty" : "attention";
    const category: ReadinessCategory = {
      key,
      label: CATEGORY_LABELS[key],
      weight: CATEGORY_WEIGHTS[key],
      score,
      status,
      acknowledged,
    };
    if (score < 100) category.suggestion = suggestionFor(key, input);
    return category;
  });

  const overall = Math.round(
    categories.reduce((sum, c) => sum + (c.weight * c.score) / 100, 0),
  );
  const completeCount = categories.filter((c) => c.score === 100).length;
  return { overall, completeCount, categories };
}

export function serializeReadinessState(state: ReadinessState): string {
  return JSON.stringify(state);
}

export function parseReadinessState(json: string): ReadinessState {
  try {
    const data = JSON.parse(json) as unknown;
    const raw = (data as { acknowledgedEmpty?: unknown }).acknowledgedEmpty;
    if (Array.isArray(raw)) {
      const keys = raw.filter(
        (k): k is ReadinessCategoryKey =>
          typeof k === "string" && (ORDER as string[]).includes(k),
      );
      return { acknowledgedEmpty: keys };
    }
  } catch {
    // fall through to default
  }
  return { acknowledgedEmpty: [] };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/readiness.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/readiness.ts src/lib/readiness.test.ts
git commit -m "feat: add pure readiness-scoring lib with unit tests"
```

---

### Task 2: `ReadinessState` Prisma model + migration (both DBs)

**Files:**
- Modify: `prisma/schema.prisma` (add `ReadinessState` model + `User.readinessState` back-relation)
- Create: `prisma/migrations/<timestamp>_readiness_state/migration.sql` (generated by Prisma)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (relied on by Tasks 3, 6): a `prisma.readinessState` delegate with `{ id, userId @unique, ciphertext, iv, createdAt, updatedAt }` and the `User.readinessState` relation.

- [ ] **Step 1: Add the back-relation to `User`**

In `prisma/schema.prisma`, inside `model User`, add after the `obituary  Obituary?` line:

```prisma
  readinessState    ReadinessState?
```

- [ ] **Step 2: Add the model**

Append to `prisma/schema.prisma`:

```prisma
model ReadinessState {
  id         String   @id @default(cuid())
  userId     String   @unique
  ciphertext String
  iv         String
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

- [ ] **Step 3: Generate + apply the migration to the dev DB**

Run: `npx prisma migrate dev --name readiness_state`
Expected: a new folder `prisma/migrations/<timestamp>_readiness_state/` with `migration.sql`, applied to the dev DB, and the Prisma client regenerated. The SQL should match:

```sql
-- CreateTable
CREATE TABLE "ReadinessState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReadinessState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReadinessState_userId_key" ON "ReadinessState"("userId");

-- AddForeignKey
ALTER TABLE "ReadinessState" ADD CONSTRAINT "ReadinessState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 4: Apply the same migration to the test DB**

Run: `npx dotenv -e .env.test -- prisma migrate deploy`
Expected: "1 migration found … applied" against the test DB (`.env.test`). (Re-running is idempotent.)

- [ ] **Step 5: Verify the client typechecks against the new model**

Run: `npx tsc --noEmit`
Expected: no errors (the regenerated client now knows `prisma.readinessState`).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add ReadinessState model + migration (dev + test DBs)"
```

---

### Task 3: `/api/readiness/state` route + api-client methods

**Files:**
- Create: `src/app/api/readiness/state/route.ts`
- Modify: `src/lib/api-client.ts` (add `getReadinessState`, `putReadinessState`)

**Interfaces:**
- Consumes: `requireUserId` (`@/lib/route-auth`), `readJsonBody` (`@/lib/http`), `prisma` (`@/lib/db`), the `prisma.readinessState` delegate from Task 2.
- Produces (relied on by Task 4, 6):
  - `GET /api/readiness/state` → `{ state: { ciphertext: string; iv: string } | null }`
  - `PUT /api/readiness/state` with body `{ ciphertext, iv }` → `{ ok: true }` (400 if either missing, 401 if unauthenticated)
  - `api.getReadinessState(): Promise<{ state: { ciphertext: string; iv: string } | null }>` (returns `{ state: null }` shape via the route; resolves `null`-state on 401-safe path)
  - `api.putReadinessState(ciphertext: string, iv: string): Promise<{ ok: true }>`

- [ ] **Step 1: Write the route**

Create `src/app/api/readiness/state/route.ts`:

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/route-auth";
import { readJsonBody } from "@/lib/http";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const row = await prisma.readinessState.findUnique({
    where: { userId },
    select: { ciphertext: true, iv: true },
  });
  return NextResponse.json({ state: row });
}

export async function PUT(req: Request) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;

  const ciphertext = typeof body.ciphertext === "string" ? body.ciphertext : "";
  const iv = typeof body.iv === "string" ? body.iv : "";
  if (!ciphertext || !iv) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }

  await prisma.readinessState.upsert({
    where: { userId },
    create: { userId, ciphertext, iv },
    update: { ciphertext, iv },
  });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Add the api-client methods**

In `src/lib/api-client.ts`, add two methods to the `api` object (after `saveObituary`, before the closing `};`). The shared `post` helper issues a `POST`, but this route is `GET`/`PUT`, so both methods use `fetch` directly (mirroring `getObituary` / `saveObituary`):

```ts
  getReadinessState: async () => {
    const res = await fetch("/api/readiness/state");
    if (res.status === 401) return { state: null };
    if (!res.ok) throw new Error("We couldn't load your readiness data.");
    return res.json() as Promise<{
      state: { ciphertext: string; iv: string } | null;
    }>;
  },
  putReadinessState: async (ciphertext: string, iv: string) => {
    const res = await fetch("/api/readiness/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ciphertext, iv }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `Request failed (${res.status})`);
    }
    return res.json() as Promise<{ ok: true }>;
  },
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run build`
Expected: build succeeds and lists the `/api/readiness/state` route.

- [ ] **Step 4: Verify the route round-trips against a live server (manual smoke)**

Start the dev server in a separate terminal (`npm run dev`), then run this one-off check against a logged-in session, or rely on the Task 6 e2e for the authoritative round-trip. If the dev server is not already running, skip to Task 6 and let the e2e cover it.

Run (only if a dev server + session cookie are handy):
```bash
curl -i http://localhost:3000/api/readiness/state
```
Expected: `401` JSON `{"error":"Unauthorized."}` when no session cookie is present (proves the login gate).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/readiness/state/route.ts src/lib/api-client.ts
git commit -m "feat: add /api/readiness/state route + api-client methods"
```

---

### Task 4: `useReadinessData` orchestration hook

**Files:**
- Create: `src/app/providers/useReadinessData.ts`

**Interfaces:**
- Consumes: `api.listRecords` / `api.getObituary` / `api.getReadinessState` / `api.putReadinessState` (`@/lib/api-client`), `useKey` (`@/app/providers/KeyProvider`), `encryptItem` / `decryptItem` (`@/lib/crypto`), `computeReadiness` / `serializeReadinessState` / `parseReadinessState` / `ReadinessReport` / `ReadinessCategoryKey` (`@/lib/readiness`), `parseAccount` / `parseBill` / `parseLoan` / `parseBeneficiary` and their types.
- Produces (relied on by Task 5): `useReadinessData()` returning `{ report: ReadinessReport; loading: boolean; error: string; masterKey: CryptoBytes | null; toggleAcknowledged: (key: ReadinessCategoryKey) => Promise<void> }`.

- [ ] **Step 1: Write the hook**

Create `src/app/providers/useReadinessData.ts`:

```ts
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { useKey } from "@/app/providers/KeyProvider";
import { encryptItem, decryptItem } from "@/lib/crypto";
import { parseAccount, type Account } from "@/lib/account";
import { parseBill, type Bill } from "@/lib/bill";
import { parseLoan, type Loan } from "@/lib/loan";
import { parseBeneficiary, type Beneficiary } from "@/lib/beneficiary";
import {
  computeReadiness,
  serializeReadinessState,
  parseReadinessState,
  type ReadinessCategoryKey,
} from "@/lib/readiness";
import type { CryptoBytes } from "@/lib/crypto";

interface EncryptedRow {
  id: string;
  ciphertext: string;
  iv: string;
}

function rowsOf(data: Record<string, unknown>, key: string): EncryptedRow[] {
  return (data[key] ?? []) as EncryptedRow[];
}

// Decrypt + parse a list, silently dropping any row that fails to decrypt.
async function decryptList<T>(
  masterKey: CryptoBytes,
  rows: EncryptedRow[],
  parse: (json: string) => T,
): Promise<T[]> {
  const out: T[] = [];
  for (const r of rows) {
    try {
      out.push(parse(await decryptItem(masterKey, r.ciphertext, r.iv)));
    } catch {
      // undecryptable row — skip it
    }
  }
  return out;
}

export function useReadinessData() {
  const router = useRouter();
  const { masterKey } = useKey();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([]);
  const [vaultCount, setVaultCount] = useState(0);
  const [obituaryDraftPresent, setObituaryDraftPresent] = useState(false);
  const [acknowledgedEmpty, setAcknowledgedEmpty] = useState<ReadinessCategoryKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!masterKey) {
      router.replace("/unlock");
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const [acctRes, billRes, loanRes, beneRes, vaultRes, obit, stateRes] =
          await Promise.all([
            api.listRecords("accounts"),
            api.listRecords("bills"),
            api.listRecords("loans"),
            api.listRecords("beneficiaries"),
            api.listRecords("vault"),
            api.getObituary(),
            api.getReadinessState(),
          ]);

        const [a, b, l, be] = await Promise.all([
          decryptList<Account>(masterKey, rowsOf(acctRes, "accounts"), parseAccount),
          decryptList<Bill>(masterKey, rowsOf(billRes, "bills"), parseBill),
          decryptList<Loan>(masterKey, rowsOf(loanRes, "loans"), parseLoan),
          decryptList<Beneficiary>(
            masterKey,
            rowsOf(beneRes, "beneficiaries"),
            parseBeneficiary,
          ),
        ]);

        let ack: ReadinessCategoryKey[] = [];
        if (stateRes.state) {
          try {
            ack = parseReadinessState(
              await decryptItem(masterKey, stateRes.state.ciphertext, stateRes.state.iv),
            ).acknowledgedEmpty;
          } catch {
            ack = [];
          }
        }

        if (cancelled) return;
        setAccounts(a);
        setBills(b);
        setLoans(l);
        setBeneficiaries(be);
        setVaultCount(rowsOf(vaultRes, "items").length);
        setObituaryDraftPresent(Boolean(obit?.obituary?.draft?.trim()));
        setAcknowledgedEmpty(ack);
        setLoading(false);
      } catch {
        if (cancelled) return;
        setError("We couldn't load some of your records. Please try again.");
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [masterKey, router]);

  const report = useMemo(
    () =>
      computeReadiness({
        accounts,
        bills,
        loans,
        beneficiaries,
        vaultCount,
        obituaryDraftPresent,
        acknowledgedEmpty,
      }),
    [accounts, bills, loans, beneficiaries, vaultCount, obituaryDraftPresent, acknowledgedEmpty],
  );

  const toggleAcknowledged = useCallback(
    async (key: ReadinessCategoryKey) => {
      if (!masterKey) return;
      const prev = acknowledgedEmpty;
      const next = prev.includes(key)
        ? prev.filter((k) => k !== key)
        : [...prev, key];
      setAcknowledgedEmpty(next); // optimistic
      setError("");
      try {
        const { ciphertext, iv } = await encryptItem(
          masterKey,
          serializeReadinessState({ acknowledgedEmpty: next }),
        );
        await api.putReadinessState(ciphertext, iv);
      } catch {
        setAcknowledgedEmpty(prev); // revert on failure
        setError("We couldn't save that change. Please try again.");
      }
    },
    [masterKey, acknowledgedEmpty],
  );

  return { report, loading, error, masterKey, toggleAcknowledged };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/providers/useReadinessData.ts
git commit -m "feat: add useReadinessData hook (load, decrypt, score, toggle)"
```

---

### Task 5: `/readiness` page + nav link + styles

**Files:**
- Create: `src/app/readiness/page.tsx`
- Modify: `src/components/AppNav.tsx` (add `Readiness` link first)
- Modify: `src/app/globals.css` (append small readiness styles)

**Interfaces:**
- Consumes: `useReadinessData` (Task 4), `AppNav`, `LegacyMark`.
- Produces: the user-facing page (terminal deliverable; nothing downstream consumes it in code).

- [ ] **Step 1: Add the nav link**

In `src/components/AppNav.tsx`, add `Readiness` as the first link inside `<div className="navlinks">`, before the Vault link:

```tsx
        <Link href="/readiness">Readiness</Link>
        <Link href="/vault">Vault</Link>
```

- [ ] **Step 2: Write the page**

Create `src/app/readiness/page.tsx`:

```tsx
"use client";

import Link from "next/link";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { useReadinessData } from "@/app/providers/useReadinessData";
import type { ReadinessCategory } from "@/lib/readiness";

const SECTION_HREF: Record<ReadinessCategory["key"], string> = {
  accounts: "/accounts",
  beneficiaries: "/beneficiaries",
  loans: "/loans",
  bills: "/bills",
  obituary: "/obituary",
  vault: "/vault",
};

const STATUS_LABEL: Record<ReadinessCategory["status"], string> = {
  complete: "Complete",
  attention: "Needs attention",
  empty: "Not started",
};

export default function ReadinessPage() {
  const { report, loading, error, masterKey, toggleAcknowledged } = useReadinessData();
  if (!masterKey) return null;

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Legacy Readiness</h1>
        <p className="subtle">A quick measure of how complete your Legacy is.</p>

        {loading && <p className="subtle">Calculating…</p>}
        {error && <p className="error">{error}</p>}

        {!loading && (
          <>
            <div className="score">
              <strong>{report.overall}%</strong>
              <span className="subtle">
                {report.completeCount} of {report.categories.length} sections complete
              </span>
            </div>

            {report.categories.map((c) => {
              const showToggle = c.acknowledged || c.status === "empty";
              const label = c.acknowledged
                ? "Complete — nothing to add"
                : STATUS_LABEL[c.status];
              return (
                <div className="item" key={c.key}>
                  <div className="readiness-row">
                    <strong>{c.label}</strong>
                    <span className={`pill pill-${c.status}`}>{label}</span>
                  </div>
                  {c.suggestion && (
                    <div className="meta">
                      {c.suggestion}{" "}
                      <Link href={SECTION_HREF[c.key]}>Open {c.label}</Link>
                    </div>
                  )}
                  {showToggle && (
                    <label className="checkrow">
                      <input
                        type="checkbox"
                        checked={c.acknowledged}
                        onChange={() => toggleAcknowledged(c.key)}
                      />
                      I have no {c.label.toLowerCase()} to add
                    </label>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Append page styles**

Open `src/app/globals.css` and append (this builds on the existing `.checkrow`, `.item`, `.meta`, `.subtle`, `.pill?` conventions — only add what's missing):

```css
.score {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  margin: 1rem 0 1.5rem;
}
.score strong {
  font-size: 2.75rem;
  line-height: 1;
}
.readiness-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.pill {
  font-size: 0.75rem;
  padding: 0.15rem 0.6rem;
  border-radius: 999px;
  white-space: nowrap;
}
.pill-complete {
  background: #e6f4ea;
  color: #1e7e34;
}
.pill-attention {
  background: #fdf3e2;
  color: #9a6700;
}
.pill-empty {
  background: #f0f0f0;
  color: #555;
}
```

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run build`
Expected: build succeeds and lists the `/readiness` route.

- [ ] **Step 5: Commit**

```bash
git add src/app/readiness/page.tsx src/components/AppNav.tsx src/app/globals.css
git commit -m "feat: add /readiness page, nav link, and styles"
```

---

### Task 6: Live e2e for the encrypted acknowledgment round-trip

**Files:**
- Modify: `e2e.spec.ts` (add a readiness-state case + imports)

**Interfaces:**
- Consumes: `serializeReadinessState` / `parseReadinessState` / `ReadinessState` (`@/lib/readiness`), the `/api/readiness/state` route (Task 3), the `prisma.readinessState` relation `User.readinessState` (Task 2).
- Produces: the authoritative proof that the acknowledgment round-trips and is stored ZK (no plaintext).

- [ ] **Step 1: Add the imports**

At the top of `e2e.spec.ts`, after the existing `@/lib/beneficiary` import block, add:

```ts
import {
  serializeReadinessState,
  parseReadinessState,
  type ReadinessState,
} from "@/lib/readiness";
```

- [ ] **Step 2: Add the test case**

Inside the `describe("walking skeleton (live)", ...)` block, add a new `it` before the closing `});`:

```ts
  it("stores and reads back the encrypted readiness acknowledgment (no plaintext)", async () => {
    const rEmail = `e2e-readiness-${Date.now()}@example.com`;
    const pass = "readiness-passphrase-123";

    // register + login
    const salt = generateSalt();
    const mk = await deriveMasterKey(pass, salt);
    const av = await deriveAuthVerifier(mk, pass);
    await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: rEmail, salt, authVerifier: av }),
    });
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: rEmail, authVerifier: av }),
    });
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    // unauthenticated GET is rejected
    const noAuth = await fetch(`${BASE}/api/readiness/state`);
    expect(noAuth.status).toBe(401);

    // no state yet for this user
    const g0 = await fetch(`${BASE}/api/readiness/state`, { headers: { cookie } });
    expect(g0.status).toBe(200);
    expect(await g0.json()).toEqual({ state: null });

    // PUT an encrypted acknowledgment blob
    const state: ReadinessState = { acknowledgedEmpty: ["loans", "bills"] };
    const { ciphertext, iv } = await encryptItem(mk, serializeReadinessState(state));
    const put = await fetch(`${BASE}/api/readiness/state`, {
      method: "PUT",
      headers: { ...json, cookie },
      body: JSON.stringify({ ciphertext, iv }),
    });
    expect(put.status).toBe(200);

    // GET returns the same blob, which decrypts back to the original state
    const g1 = await fetch(`${BASE}/api/readiness/state`, { headers: { cookie } });
    const { state: stored } = await g1.json();
    expect(stored).toBeTruthy();
    expect(
      parseReadinessState(await decryptItem(mk, stored.ciphertext, stored.iv)),
    ).toEqual(state);

    // upsert: a second PUT overwrites rather than duplicates
    const state2: ReadinessState = { acknowledgedEmpty: ["vault"] };
    const enc2 = await encryptItem(mk, serializeReadinessState(state2));
    await fetch(`${BASE}/api/readiness/state`, {
      method: "PUT",
      headers: { ...json, cookie },
      body: JSON.stringify(enc2),
    });
    const g2 = await fetch(`${BASE}/api/readiness/state`, { headers: { cookie } });
    const { state: stored2 } = await g2.json();
    expect(
      parseReadinessState(await decryptItem(mk, stored2.ciphertext, stored2.iv)),
    ).toEqual(state2);

    // ZERO-KNOWLEDGE: the stored row holds only ciphertext — no plaintext keys
    const user = await db.user.findUnique({
      where: { email: rEmail },
      include: { readinessState: true },
    });
    expect(user!.readinessState).toBeTruthy();
    expect(user!.readinessState!.ciphertext).not.toContain("vault");
    expect(user!.readinessState!.ciphertext).not.toContain("acknowledgedEmpty");

    // cleanup
    await db.user.delete({ where: { email: rEmail } });
  }, 60_000);
```

- [ ] **Step 3: Run the full unit suite + gates**

Run: `npm test`
Expected: PASS (existing suites + Task 1's readiness tests).

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Run the live e2e against a running dev server**

In one terminal: `npm run dev` (with `.env` pointing `DATABASE_URL` at the dev public-proxy URL).
In another: `npx vitest run --config vitest.e2e.config.ts`
Expected: all e2e cases PASS, including the new "encrypted readiness acknowledgment" case. (If `/api/*` 404s, stop dev, delete `.next`, restart — stale Turbopack cache.)

- [ ] **Step 5: Commit**

```bash
git add e2e.spec.ts
git commit -m "test: add live e2e for encrypted readiness acknowledgment round-trip"
```

---

## Final review checklist (run after all tasks)

- [ ] `npm test` green (unit, incl. readiness).
- [ ] `npx tsc --noEmit` clean.
- [ ] `npm run build` clean, `/readiness` + `/api/readiness/state` listed.
- [ ] Live e2e green (`npx vitest run --config vitest.e2e.config.ts`).
- [ ] Manual smoke: `npm run dev` → log in / unlock → `/readiness` shows the score, suggestions link to each section, a "Nothing to add" toggle on an empty category persists across reload, and the overall reaches 100% when all six are complete/acknowledged.
- [ ] Memory + `finishing-a-development-branch` to merge `sprint3-readiness-scoring` into `main`.
