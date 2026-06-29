# Loans / Mortgages slice — design

**Date:** 2026-06-29
**Sprint:** Sprint 2, slice 4 (next financial record type)
**Pattern:** Shared encrypted-record abstraction (see `2026-06-29-legacy-encrypted-record-abstraction-design.md` and `AGENTS.md`).

## Goal

Add a dedicated debt tracker — a new encrypted-record type, **Loans**, covering
mortgages, auto, student, personal, HELOC, and other loans as kinds of one
record. This is a thin instance of the shared abstraction; the bulk of the
control flow (gate / redirect / load / decrypt / add / error) is reused from
`useEncryptedRecords`, and the server only ever sees `{ ciphertext, iv }` blobs.

Bills already has a "Loan" *category* for recurring payments; this Loans type is
the place to track the underlying debt (balance, rate, payoff), which is
distinct from a recurring bill line.

## Zero-knowledge invariant

Unchanged and preserved automatically. The page encrypts each loan client-side
via `encryptItem` (through `useEncryptedRecords`); the server route stores only
opaque `{ ciphertext, iv }`. No new server-side plaintext handling is introduced.

## 1. Domain lib — `src/lib/loan.ts` (pure, unit-tested)

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
  lender: string;          // institution / servicer
  nickname: string;
  accountNumber: string;
  originalAmount: string;  // free-text, parsed defensively
  currentBalance: string;  // free-text, parsed defensively
  interestRate: string;    // APR, e.g. "6.25%"
  monthlyPayment: string;  // free-text, parsed defensively
  nextPaymentDate: string; // "YYYY-MM-DD" or ""
  payoffDate: string;      // maturity, "YYYY-MM-DD" or ""
  notes: string;
}
```

Helpers (module-level, stable refs so the hook does not refetch-loop):

- `serializeLoan(l: Loan): string` — `JSON.stringify`.
- `parseLoan(json: string): Loan` — `JSON.parse`.
- `totalBalance(loans: Loan[]): number` — sum of defensively-parsed
  `currentBalance`.
- `totalMonthly(loans: Loan[]): number` — sum of defensively-parsed
  `monthlyPayment`.
- `formatMoney(n: number): string` — `"$" + rounded.toLocaleString("en-US")`.
  Local copy, matching `bill.ts`; domain libs stay self-contained rather than
  cross-importing.
- `sortByNextPaymentDate(loans: Loan[]): Loan[]` — ascending by
  `nextPaymentDate`, blanks last, **non-mutating** (copy first), matching
  `sortByDueDate` in `bill.ts`.
- `maskAccountNumber(value: string): string` — same approach as `account.ts`
  (`••••` + last 4) for card display.

Defensive amount parsing follows `bill.ts`: strip everything but digits and `.`,
`parseFloat`, fall back to `0` for empty / non-numeric.

### Unit tests — `src/lib/loan.test.ts`

- round-trips through `serializeLoan` / `parseLoan` preserving all fields
- `totalBalance` / `totalMonthly` sum a mixed set; `0` for `[]`
- defensive parsing: `""`, `"n/a"`, `"$1,200"` handled
- `formatMoney` rounds to whole dollars
- `sortByNextPaymentDate` orders ascending, blanks last, does not mutate input
- `maskAccountNumber` masks all but last 4, leaves short values alone

## 2. Prisma model `Loan`

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

Plus `loans Loan[]` on the `User` model.

Migration `*_loans` created and applied to **both** dev (`.env`) and test
(`.env.test`) DBs. Commit the migration SQL under `prisma/migrations/` so the
pipeline applies it (per `AGENTS.md` — confirm before running against non-local
environments; dev + test here are the two local Railway instances).

## 3. Route — `src/app/api/loans/route.ts`

```ts
import { createEncryptedRecordRoute } from "@/lib/encrypted-record-route";

export const { GET, POST } = createEncryptedRecordRoute({
  model: "loan",
  listKey: "loans",
});
```

Extend `RecordModel` union and the delegate `switch` in
`encrypted-record-route.ts` with `"loan" → prisma.loan`.

## 4. Page — `src/app/loans/page.tsx`

Bespoke form + cards consuming `useEncryptedRecords<Loan>({ resource: "loans",
listKey: "loans", serialize: serializeLoan, parse: parseLoan, noun: "loans" })`.

- Form fields for all 11 `Loan` fields: `kind` (select), `lender`, `nickname`,
  `accountNumber`, `originalAmount`, `currentBalance`, `interestRate`,
  `monthlyPayment`, `nextPaymentDate` (date), `payoffDate` (date), `notes`
  (textarea). `lender` (or `nickname`) required to add.
- Two summary lines when loans exist:
  - `~$X owed across N loan(s)` via `formatMoney(totalBalance(...))`
  - `~$Y/mo in payments` via `formatMoney(totalMonthly(...))`
- Cards sorted by `sortByNextPaymentDate`, showing kind · lender, masked account
  number, balance, rate, monthly payment, next payment / payoff dates, notes.
- Reuse the empty-state and "couldn't unlock some" messaging from the bills page.

## 5. Nav

Add `<Link href="/loans">Loans</Link>` to `AppNav.tsx`, after Bills.

## Verification

1. `npm test` — `loan.test.ts` (+ existing suite) green.
2. `npx tsc --noEmit` — typecheck gate (Vitest does not type-check).
3. `npm run build` — build gate.
4. Live e2e (`npx vitest run --config vitest.e2e.config.ts` against `npm run dev`
   + dev DB) — proves the full zero-knowledge round-trip and no-plaintext storage
   for loans, if the e2e harness is extended to cover the new resource.

## Out of scope (YAGNI)

- Editing / deleting loans (no record type has this yet; add uniformly later).
- Amortization schedules, payoff projections, interest computations.
- Mortgage-specific fields (escrow, property address, PMI) — `Other`/`notes`
  cover edge cases for now.
