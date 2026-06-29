# Beneficiaries Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Beneficiaries" encrypted-record type to Legacy using the shared encrypted-record abstraction, mirroring the Loans/Mortgages slice.

**Architecture:** A new encrypted-record type is thin: a pure domain lib (`src/lib/beneficiary.ts`) with `serialize`/`parse` + display helpers; a `Beneficiary` Prisma model (`{ id, userId, ciphertext, iv, createdAt }`) with one migration applied to both DBs; a one-line route built from `createEncryptedRecordRoute`; a bespoke page consuming the generic `useEncryptedRecords` hook; and a nav link. The zero-knowledge invariant holds: the server stores only `{ ciphertext, iv }` blobs; all encrypt/decrypt is client-side.

**Tech Stack:** Next.js 16 (App Router, TS strict), Prisma 6 → Railway Postgres, WebCrypto via `src/lib/crypto.ts`, Vitest.

## Global Constraints

- **Zero-knowledge invariant:** server persists only `{ ciphertext, iv }`; never plaintext, never the key. All encrypt/decrypt is client-side via `src/lib/crypto.ts`.
- **Stable serialize/parse:** pass module-level functions (`serializeBeneficiary`/`parseBeneficiary`) to the hook — never inline lambdas.
- **One migration, both DBs:** apply the new migration to dev (`.env`) and test (`.env.test`); commit the migration file under `prisma/migrations/`.
- **Required fields:** only `fullName` and `relationship` are required; every other field is optional and defaults to `""`.
- **Verification gates (run in order at the end):** `npm test` → `npx tsc --noEmit` → `npm run build` → live e2e (`npx vitest run --config vitest.e2e.config.ts` against a running `npm run dev` + dev DB).
- **Windows/Turbopack gotcha:** if `/api/*` 404s under dev, stop the dev server, delete `.next`, restart (server must be stopped before deleting `.next` on Windows).

---

### Task 1: Beneficiary domain lib

**Files:**
- Create: `src/lib/beneficiary.ts`
- Test: `src/lib/beneficiary.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type BeneficiaryRelationship = "Spouse" | "Child" | "Parent" | "Sibling" | "Friend" | "Trust" | "Charity" | "Other"`
  - `interface Beneficiary { fullName: string; relationship: BeneficiaryRelationship; email: string; phone: string; mailingAddress: string; allocation: string; notes: string }`
  - `serializeBeneficiary(b: Beneficiary): string`
  - `parseBeneficiary(json: string): Beneficiary`
  - `totalAllocation(beneficiaries: Beneficiary[]): number`
  - `allocationStatus(total: number): "balanced" | "under" | "over"`
  - `sortByAllocationDesc(beneficiaries: Beneficiary[]): Beneficiary[]`
  - `maskContact(value: string): string`

- [ ] **Step 1: Write the failing test**

Create `src/lib/beneficiary.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  serializeBeneficiary,
  parseBeneficiary,
  totalAllocation,
  allocationStatus,
  sortByAllocationDesc,
  maskContact,
  type Beneficiary,
} from "@/lib/beneficiary";

const sample: Beneficiary = {
  fullName: "Jane Doe",
  relationship: "Spouse",
  email: "jane@example.com",
  phone: "555-123-4567",
  mailingAddress: "12 Oak St, Springfield",
  allocation: "50",
  notes: "Primary beneficiary",
};

function beneficiary(partial: Partial<Beneficiary>): Beneficiary {
  return { ...sample, ...partial };
}

describe("beneficiary domain", () => {
  it("round-trips through serialize/parse, preserving every field", () => {
    expect(parseBeneficiary(serializeBeneficiary(sample))).toEqual(sample);
  });

  it("sums allocations across a mixed set, defensively; 0 for none", () => {
    const set = [
      beneficiary({ allocation: "50" }),
      beneficiary({ allocation: "25.5%" }),
      beneficiary({ allocation: "" }),
      beneficiary({ allocation: "n/a" }),
    ];
    expect(totalAllocation(set)).toBeCloseTo(75.5);
    expect(totalAllocation([])).toBe(0);
  });

  it("classifies allocation totals at the 100% thresholds", () => {
    expect(allocationStatus(99)).toBe("under");
    expect(allocationStatus(100)).toBe("balanced");
    expect(allocationStatus(101)).toBe("over");
  });

  it("sorts by allocation descending, ties broken by name, without mutating input", () => {
    const input = [
      beneficiary({ fullName: "Bob", allocation: "25" }),
      beneficiary({ fullName: "Alice", allocation: "50" }),
      beneficiary({ fullName: "Carol", allocation: "25" }),
    ];
    const sorted = sortByAllocationDesc(input);
    expect(sorted.map((b) => b.fullName)).toEqual(["Alice", "Bob", "Carol"]);
    expect(input.map((b) => b.fullName)).toEqual(["Bob", "Alice", "Carol"]); // input untouched
  });

  it("masks an email to its first letter and domain", () => {
    expect(maskContact("jane@example.com")).toBe("j***@example.com");
  });

  it("masks a phone/other value to the last four characters", () => {
    expect(maskContact("5551234567")).toBe("••••4567");
    expect(maskContact("123")).toBe("123");
    expect(maskContact("")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/beneficiary.test.ts`
Expected: FAIL — cannot resolve `@/lib/beneficiary` (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/beneficiary.ts`:

```ts
export type BeneficiaryRelationship =
  | "Spouse"
  | "Child"
  | "Parent"
  | "Sibling"
  | "Friend"
  | "Trust"
  | "Charity"
  | "Other";

export interface Beneficiary {
  fullName: string;
  relationship: BeneficiaryRelationship;
  email: string;
  phone: string;
  mailingAddress: string;
  allocation: string; // percent as free text, e.g. "50" — "" when unset
  notes: string;
}

export function serializeBeneficiary(b: Beneficiary): string {
  return JSON.stringify(b);
}

export function parseBeneficiary(json: string): Beneficiary {
  return JSON.parse(json) as Beneficiary;
}

// Parse a free-text percentage defensively: drop "%", spaces, and stray
// characters, then parseFloat. Non-numeric / empty -> 0.
function parsePercent(value: string): number {
  const cleaned = value.replace(/[^0-9.]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function totalAllocation(beneficiaries: Beneficiary[]): number {
  return beneficiaries.reduce((sum, b) => sum + parsePercent(b.allocation), 0);
}

export function allocationStatus(total: number): "balanced" | "under" | "over" {
  if (Math.abs(total - 100) < 0.005) return "balanced";
  return total < 100 ? "under" : "over";
}

export function sortByAllocationDesc(beneficiaries: Beneficiary[]): Beneficiary[] {
  return [...beneficiaries].sort((a, b) => {
    const diff = parsePercent(b.allocation) - parsePercent(a.allocation);
    if (diff !== 0) return diff;
    return a.fullName.localeCompare(b.fullName);
  });
}

// Mask a contact string for card display. Emails keep their first letter and
// full domain (j***@example.com); other values (phones) keep the last four
// characters. Values of length <= 4 and "" are returned unchanged.
export function maskContact(value: string): string {
  if (!value) return "";
  const at = value.indexOf("@");
  if (at > 0) {
    return value[0] + "***" + value.slice(at);
  }
  if (value.length <= 4) return value;
  return "••••" + value.slice(-4);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/beneficiary.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/beneficiary.ts src/lib/beneficiary.test.ts
git commit -m "feat: add beneficiary domain lib (serialize/parse, allocation totals, sort, mask)"
```

---

### Task 2: Prisma model + migration (both DBs)

**Files:**
- Modify: `prisma/schema.prisma` (add `Beneficiary` model + `User.beneficiaries` relation)
- Create: `prisma/migrations/<timestamp>_beneficiaries/migration.sql` (generated by Prisma)

**Interfaces:**
- Consumes: nothing.
- Produces: the `prisma.beneficiary` delegate (used by Task 3) and the `Beneficiary` table in both DBs.

- [ ] **Step 1: Add the relation field to the User model**

In `prisma/schema.prisma`, add `beneficiaries Beneficiary[]` to the `User` model alongside the existing relations:

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
  beneficiaries     Beneficiary[]
}
```

- [ ] **Step 2: Add the Beneficiary model**

Append to the end of `prisma/schema.prisma`:

```prisma
model Beneficiary {
  id         String   @id @default(cuid())
  userId     String
  ciphertext String
  iv         String
  createdAt  DateTime @default(now())
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

- [ ] **Step 3: Create + apply the migration to the dev DB (and regenerate the client)**

Run: `npx prisma migrate dev --name beneficiaries`
Expected: Prisma creates `prisma/migrations/<timestamp>_beneficiaries/migration.sql`, applies it to the dev DB (`.env`), and regenerates the Prisma client so `prisma.beneficiary` exists. The generated `migration.sql` should match:

```sql
-- CreateTable
CREATE TABLE "Beneficiary" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Beneficiary_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Beneficiary" ADD CONSTRAINT "Beneficiary_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 4: Apply the same migration to the test DB**

Run: `npx dotenv -e .env.test -- npx prisma migrate deploy`
Expected: "1 migration applied" (the `_beneficiaries` migration) against the test DB. No schema reset.

- [ ] **Step 5: Verify the delegate compiles**

Run: `npx tsc --noEmit`
Expected: PASS (the regenerated client now types `prisma.beneficiary`).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add Beneficiary prisma model and migration"
```

---

### Task 3: API route

**Files:**
- Modify: `src/lib/encrypted-record-route.ts` (extend `RecordModel` union + delegate switch)
- Create: `src/app/api/beneficiaries/route.ts`

**Interfaces:**
- Consumes: `createEncryptedRecordRoute({ model, listKey })`; the `prisma.beneficiary` delegate from Task 2.
- Produces: `GET`/`POST` handlers at `/api/beneficiaries`; GET returns `{ beneficiaries: BlobRow[] }`, POST accepts `{ ciphertext, iv }` and returns `{ id }` (201).

- [ ] **Step 1: Add `"beneficiary"` to the RecordModel union**

In `src/lib/encrypted-record-route.ts`, change the union type:

```ts
type RecordModel = "vaultItem" | "financialAccount" | "bill" | "loan" | "beneficiary";
```

- [ ] **Step 2: Add the delegate switch case**

In the same file, inside the `switch (opts.model)` block, add the case after `case "loan":`:

```ts
      case "beneficiary":
        return prisma.beneficiary as unknown as BlobDelegate;
```

- [ ] **Step 3: Create the route**

Create `src/app/api/beneficiaries/route.ts`:

```ts
import { createEncryptedRecordRoute } from "@/lib/encrypted-record-route";

export const { GET, POST } = createEncryptedRecordRoute({
  model: "beneficiary",
  listKey: "beneficiaries",
});
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (the switch is now exhaustive over the extended union).

- [ ] **Step 5: Commit**

```bash
git add src/lib/encrypted-record-route.ts src/app/api/beneficiaries/route.ts
git commit -m "feat: add /api/beneficiaries encrypted-record route"
```

---

### Task 4: Page + nav link

**Files:**
- Create: `src/app/beneficiaries/page.tsx`
- Modify: `src/components/AppNav.tsx` (add the nav link)

**Interfaces:**
- Consumes: `useEncryptedRecords<Beneficiary>`; all exports from `src/lib/beneficiary.ts`; `AppNav`, `LegacyMark`.
- Produces: the `/beneficiaries` page and a nav entry.

- [ ] **Step 1: Create the page**

Create `src/app/beneficiaries/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { useEncryptedRecords } from "@/app/providers/useEncryptedRecords";
import {
  type Beneficiary,
  type BeneficiaryRelationship,
  serializeBeneficiary,
  parseBeneficiary,
  totalAllocation,
  allocationStatus,
  sortByAllocationDesc,
  maskContact,
} from "@/lib/beneficiary";

const RELATIONSHIPS: BeneficiaryRelationship[] = [
  "Spouse",
  "Child",
  "Parent",
  "Sibling",
  "Friend",
  "Trust",
  "Charity",
  "Other",
];

const EMPTY: Beneficiary = {
  fullName: "",
  relationship: "Spouse",
  email: "",
  phone: "",
  mailingAddress: "",
  allocation: "",
  notes: "",
};

const pct = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export default function BeneficiariesPage() {
  const { items, error, loaded, add, masterKey } = useEncryptedRecords<Beneficiary>({
    resource: "beneficiaries",
    listKey: "beneficiaries",
    serialize: serializeBeneficiary,
    parse: parseBeneficiary,
    noun: "beneficiaries",
  });
  const [draft, setDraft] = useState<Beneficiary>(EMPTY);

  function set<K extends keyof Beneficiary>(key: K, value: Beneficiary[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.fullName.trim()) return;
    if (await add(draft)) setDraft(EMPTY);
  }

  if (!masterKey) return null;

  const decrypted = items
    .map((it) => it.value)
    .filter((b): b is Beneficiary => b !== null);
  const sorted = sortByAllocationDesc(decrypted);
  const total = totalAllocation(decrypted);
  const status = allocationStatus(total);

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Beneficiaries</h1>
        <p className="subtle">Each beneficiary is encrypted on your device.</p>

        <form onSubmit={onAdd}>
          <label htmlFor="fullName">Full name</label>
          <input
            id="fullName"
            value={draft.fullName}
            onChange={(e) => set("fullName", e.target.value)}
          />

          <label htmlFor="relationship">Relationship</label>
          <select
            id="relationship"
            value={draft.relationship}
            onChange={(e) => set("relationship", e.target.value as BeneficiaryRelationship)}
          >
            {RELATIONSHIPS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>

          <label htmlFor="email">Email</label>
          <input
            id="email"
            value={draft.email}
            onChange={(e) => set("email", e.target.value)}
          />

          <label htmlFor="phone">Phone</label>
          <input
            id="phone"
            value={draft.phone}
            onChange={(e) => set("phone", e.target.value)}
          />

          <label htmlFor="mailingAddress">Mailing address</label>
          <input
            id="mailingAddress"
            value={draft.mailingAddress}
            onChange={(e) => set("mailingAddress", e.target.value)}
          />

          <label htmlFor="allocation">Allocation (%)</label>
          <input
            id="allocation"
            value={draft.allocation}
            onChange={(e) => set("allocation", e.target.value)}
          />

          <label htmlFor="notes">Notes</label>
          <textarea
            id="notes"
            value={draft.notes}
            onChange={(e) => set("notes", e.target.value)}
          />

          <button type="submit">Add beneficiary</button>
        </form>

        {error && <p className="error">{error}</p>}

        {decrypted.length > 0 && (
          <p className="subtle">
            {status === "balanced"
              ? `Allocated: 100% across ${decrypted.length} ${
                  decrypted.length === 1 ? "beneficiary" : "beneficiaries"
                }`
              : status === "under"
                ? `Allocated: ${pct(total)}% — ${pct(100 - total)}% unassigned`
                : `Over-allocated by ${pct(total - 100)}%`}
          </p>
        )}

        {loaded && items.length === 0 && (
          <p className="subtle">No beneficiaries yet. Add your first above.</p>
        )}

        {items.some((it) => it.value === null) && (
          <p className="subtle">We couldn&apos;t unlock some beneficiaries.</p>
        )}

        {sorted.map((b, i) => (
          <div className="item" key={i}>
            <strong>{b.fullName || "Unnamed beneficiary"}</strong>
            <div className="meta">
              {b.relationship}
              {b.allocation ? ` · ${b.allocation}%` : ""}
            </div>
            {b.email && <div className="meta">{maskContact(b.email)}</div>}
            {b.phone && <div className="meta">{maskContact(b.phone)}</div>}
            {b.mailingAddress && <div className="meta">{b.mailingAddress}</div>}
            {b.notes && <div className="notes">{b.notes}</div>}
          </div>
        ))}
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Add the nav link**

In `src/components/AppNav.tsx`, add the Beneficiaries link after the Loans link inside `.navlinks`:

```tsx
        <Link href="/vault">Vault</Link>
        <Link href="/accounts">Accounts</Link>
        <Link href="/bills">Bills</Link>
        <Link href="/loans">Loans</Link>
        <Link href="/beneficiaries">Beneficiaries</Link>
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS — `/beneficiaries` and `/api/beneficiaries` appear in the route list.

- [ ] **Step 5: Commit**

```bash
git add src/app/beneficiaries/page.tsx src/components/AppNav.tsx
git commit -m "feat: add beneficiaries page and nav link"
```

---

### Task 5: Live e2e round-trip + no-plaintext check

**Files:**
- Modify: `e2e.spec.ts` (add a new `it(...)` block + import the beneficiary lib)

**Interfaces:**
- Consumes: `serializeBeneficiary`, `parseBeneficiary`, `Beneficiary` from `src/lib/beneficiary.ts`; the live `/api/beneficiaries` route; the dev DB client `db`.
- Produces: a passing live e2e proving the zero-knowledge round-trip for beneficiaries.

- [ ] **Step 1: Add the beneficiary import**

In `e2e.spec.ts`, add after the loan import (line ~18):

```ts
import {
  serializeBeneficiary,
  parseBeneficiary,
  type Beneficiary,
} from "@/lib/beneficiary";
```

- [ ] **Step 2: Write the failing e2e test**

In `e2e.spec.ts`, add this block inside the `describe("walking skeleton (live)", ...)` body, after the loan `it(...)` (before the closing `});` of the describe):

```ts
  it("stores and reads back an encrypted beneficiary", async () => {
    const beEmail = `e2e-bene-${Date.now()}@example.com`;
    const pass = "beneficiary-passphrase-123";

    // register + login
    const salt = generateSalt();
    const mk = await deriveMasterKey(pass, salt);
    const av = await deriveAuthVerifier(mk, pass);
    await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: beEmail, salt, authVerifier: av }),
    });
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: beEmail, authVerifier: av }),
    });
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    // encrypt + store a beneficiary
    const beneficiaryRecord: Beneficiary = {
      fullName: "Jane Doe",
      relationship: "Spouse",
      email: "jane@example.com",
      phone: "555-123-4567",
      mailingAddress: "12 Oak St, Springfield",
      allocation: "50",
      notes: "Primary beneficiary",
    };
    const { ciphertext, iv } = await encryptItem(mk, serializeBeneficiary(beneficiaryRecord));
    const add = await fetch(`${BASE}/api/beneficiaries`, {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ ciphertext, iv }),
    });
    expect(add.status).toBe(201);

    // list + decrypt
    const list = await fetch(`${BASE}/api/beneficiaries`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const { beneficiaries } = await list.json();
    expect(beneficiaries).toHaveLength(1);
    const back = parseBeneficiary(
      await decryptItem(mk, beneficiaries[0].ciphertext, beneficiaries[0].iv),
    );
    expect(back).toEqual(beneficiaryRecord);

    // zero-knowledge: stored row has no plaintext
    const user = await db.user.findUnique({
      where: { email: beEmail },
      include: { beneficiaries: true },
    });
    const stored = user!.beneficiaries[0];
    expect(stored.ciphertext).not.toContain("Jane Doe");
    expect(stored.ciphertext).not.toContain("jane@example.com");

    // cleanup
    await db.user.delete({ where: { email: beEmail } });
  }, 60_000);
```

- [ ] **Step 3: Start the dev server (separate terminal)**

Run (in its own terminal, leave running): `npm run dev`
Expected: server listening on `http://localhost:3000`. If `/api/*` 404s, stop the server, delete `.next`, restart.

- [ ] **Step 4: Run the live e2e**

Run: `npx vitest run --config vitest.e2e.config.ts`
Expected: PASS — all blocks pass, including "stores and reads back an encrypted beneficiary".

- [ ] **Step 5: Commit**

```bash
git add e2e.spec.ts
git commit -m "test: add live e2e beneficiary round-trip + no-plaintext check"
```

---

## Final verification (all gates)

- [ ] `npm test` — unit suite green (includes `beneficiary.test.ts`).
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run build` — clean; `/beneficiaries` + `/api/beneficiaries` in the route list.
- [ ] `npx vitest run --config vitest.e2e.config.ts` (with `npm run dev` running) — green.
- [ ] Update `MEMORY.md` project-state note: Beneficiaries slice done.
