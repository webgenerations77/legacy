# Legacy Readiness Scoring — Design

**Date:** 2026-06-29
**Sprint:** 3 (AI Assistant) — Slice 2
**Status:** Approved (pending spec review)

## Overview

A vault-gated `/readiness` page showing a single weighted "how complete is your
Legacy" score plus a per-category breakdown with concrete next steps. All scoring
is **pure client-side logic** over already-decrypted records — no AI, no network
inference, and **no new plaintext on the server**. Categories a user legitimately
has nothing to add for (e.g. a debt-free user with no loans) can be marked
"Nothing to add"; that flag is persisted as an **encrypted singleton**, which
keeps the zero-knowledge invariant intact and keeps 100% reachable for everyone.

This is the lowest-risk Sprint 3 slice: it operates on records that are already
decrypted in the browser, so it introduces **no new zero-knowledge tension**.

## Goals

- Give the user an at-a-glance sense of how complete their estate plan is.
- Point them at the specific next thing to do, per category.
- Preserve the zero-knowledge invariant exactly as it stands today.
- Keep the scoring logic pure and fully unit-testable.

## Non-goals (v1)

- AI / LLM-generated narrative or personalized guidance.
- Deep per-field quality scoring (every field of every record).
- User-tunable category weights.
- History / trend of the score over time.

## Categories & weights

Weighted by importance — estate-critical categories highest, end-of-life /
optional lowest. Weights sum to 100.

| Category      | Weight | Sub-score rule (presence + key signal)                              |
|---------------|:------:|---------------------------------------------------------------------|
| Accounts      |   25   | ≥1 account → 100, else 0                                             |
| Beneficiaries |   25   | 60 pts for ≥1 beneficiary, +40 pts if `allocationStatus` = balanced |
| Loans         |   15   | ≥1 loan → 100, else 0                                                |
| Bills         |   15   | ≥1 bill → 100, else 0                                                |
| Obituary      |   10   | saved draft (non-empty) → 100, else 0                               |
| Vault         |   10   | ≥1 note → 100, else 0                                                |

**"Nothing to add" acknowledgment** on any category forces that category's
sub-score to 100 (it counts as complete).

**Overall score** = `round( Σ (weightᵢ × sub-scoreᵢ / 100) )`, an integer 0–100.

**Per-category status** (derived from the sub-score):

- `100` → **Complete** — or **Complete — nothing to add** when acknowledged.
- `0 < n < 100` → **Needs attention** (only Beneficiaries can land here, via the
  presence-but-unbalanced case).
- `0` → **Not started**.

Each incomplete card shows a templated suggestion linking to that section's page:

- Accounts: "Add your financial accounts so survivors know what exists."
- Beneficiaries (none): "Add at least one beneficiary."
- Beneficiaries (unbalanced): "Allocations total {X}% — adjust to 100%."
  (`{X}` from `totalAllocation`.)
- Loans: "Add your loans, or mark 'Nothing to add'."
- Bills: "Add your recurring bills, or mark 'Nothing to add'."
- Obituary: "Draft an obituary, or mark 'Nothing to add'."
- Vault: "Save important notes to your vault, or mark 'Nothing to add'."

## Components

### `src/lib/readiness.ts` (pure, unit-tested) — the heart

- `type ReadinessCategoryKey = "accounts" | "beneficiaries" | "loans" | "bills" | "obituary" | "vault"`
- Exported weight constants (one map keyed by `ReadinessCategoryKey`).
- `computeReadiness(input: ReadinessInput): ReadinessReport`

  ```
  interface ReadinessInput {
    accounts: FinancialAccount[];
    bills: Bill[];
    loans: Loan[];
    beneficiaries: Beneficiary[];
    vaultCount: number;            // vault items are opaque strings — count only
    obituaryDraftPresent: boolean; // from the existing login-gated GET
    acknowledgedEmpty: ReadinessCategoryKey[];
  }

  interface ReadinessCategory {
    key: ReadinessCategoryKey;
    label: string;
    weight: number;
    score: number;        // 0–100 sub-score
    status: "complete" | "attention" | "empty";
    acknowledged: boolean;
    suggestion?: string;  // present when score < 100
  }
  // status mapping: score 100 → "complete"; 0 < score < 100 → "attention";
  // score 0 → "empty". The page renders these as the display labels below
  // ("Complete" / "Complete — nothing to add" / "Needs attention" / "Not started").

  interface ReadinessReport {
    overall: number;               // 0–100 integer
    completeCount: number;         // categories at score 100 (of 6)
    categories: ReadinessCategory[];
  }
  ```

- `serializeReadinessState(s: ReadinessState): string` /
  `parseReadinessState(json: string): ReadinessState` where
  `interface ReadinessState { acknowledgedEmpty: ReadinessCategoryKey[] }`.
  `parseReadinessState` defends against malformed input (returns
  `{ acknowledgedEmpty: [] }` on bad/legacy data) so a corrupt blob can't crash
  the page.

The lib does pure math only — it imports the record types but performs no IO.

### Prisma `ReadinessState` model

```
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

Plus the back-relation field on `User`. One migration, committed under
`prisma/migrations/`, applied to **both** the dev (`.env`) and test (`.env.test`)
DBs. The stored content is an opaque encrypted blob — the server never learns
which categories were acknowledged.

### `src/app/api/readiness/state/route.ts` (bespoke singleton route)

- `GET` → `{ state: { ciphertext, iv } | null }`, login-gated via `requireUserId`
  (returns 401 when unauthenticated).
- `PUT` → upsert `{ ciphertext, iv }` for the user; validates both fields are
  non-empty strings (mirrors `createEncryptedRecordRoute`'s body check); returns
  `{ ok: true }`.

This mirrors the obituary route's per-user singleton shape, but the payload is
ciphertext rather than plaintext.

### `src/lib/api-client.ts`

Add two methods:

- `getReadinessState()` → `{ state: { ciphertext, iv } | null }` (returns `null`
  on 401, like `getObituary`).
- `putReadinessState(ciphertext, iv)` → `{ ok: true }`.

The 5 encrypted record types reuse the generic `listRecords`; the obituary reuses
the existing `getObituary()`.

### `src/app/providers/useReadinessData.ts` (orchestration hook)

Encapsulates all IO so the page stays lean and the math stays pure:

1. Gate: if no `masterKey`, redirect to `/unlock` and bail (same pattern as
   `useEncryptedRecords`).
2. Load in parallel: `listRecords` for accounts/bills/loans/beneficiaries/vault;
   `getObituary()`; `getReadinessState()`.
3. Decrypt each encrypted list in-browser (`decryptItem`), parse with the
   per-type `parse*` function; a row that fails to decrypt is dropped from that
   category's array (graceful degradation). Decrypt + parse the ack blob if
   present.
4. Compute the report via `computeReadiness`.
5. Expose `{ report, loading, error, masterKey, toggleAcknowledged }`.
   `toggleAcknowledged(key)` flips the key in `acknowledgedEmpty`, re-encrypts the
   blob, `PUT`s it, and recomputes; on PUT failure it reverts and surfaces an
   inline error.

### `src/app/readiness/page.tsx`

- Client component; renders `null` while redirecting if `!masterKey`.
- Header: the overall score (large) with "{completeCount} of 6 sections complete".
- A card per category: label, status pill, weight, suggestion link (to that
  section's page) when incomplete, and a "Nothing to add" toggle shown when the
  category is empty and not already complete-by-records.
- Calm Legacy brand styling, consistent with the other pages.

### `src/components/AppNav.tsx`

Add a `Readiness` link as the **first** nav item (the overview / "start here"
entry point), ahead of Vault.

## Data flow & zero-knowledge

- The page requires the master key, exactly like every encrypted-record page.
- The 5 encrypted lists are decrypted **in-browser only**; plaintext never leaves
  the device.
- The acknowledgment blob is **encrypted in-browser**; the server stores and
  returns only `{ ciphertext, iv }`.
- Obituary presence comes from the existing, already-sanctioned login-gated
  plaintext GET (`getObituary`) — no new server-side plaintext is introduced.

**No new plaintext user data reaches the server. The zero-knowledge invariant is
structurally untouched.**

## Error handling

- A per-resource load failure surfaces a calm banner ("We couldn't load some of
  your records") without crashing the page.
- A category whose rows fail to decrypt degrades to **Not started** rather than
  throwing.
- An ack `PUT` failure shows an inline message and reverts the toggle to its
  prior state.

## Testing

- **Unit — `src/lib/readiness.test.ts`:**
  - Empty everything → overall 0, all categories **Not started**.
  - All present and beneficiaries balanced → overall 100, all **Complete**.
  - Beneficiaries present but unbalanced → that category partial (**Needs
    attention**), correct contribution to overall.
  - Acknowledged-empty categories count as complete and lift the overall.
  - Weighting math: only Accounts present → overall 25; only Beneficiaries
    balanced → 25; etc.
  - Rounding behavior of the overall integer.
  - `serializeReadinessState` / `parseReadinessState` round-trip, plus
    `parseReadinessState` on malformed input → `{ acknowledgedEmpty: [] }`.
- **Live e2e (extends `vitest.e2e.config.ts`):** readiness-state round-trip —
  with a minted session, `GET` returns `null`, `PUT` an encrypted ack blob, `GET`
  returns the same blob; assert the stored row contains **no plaintext category
  names** (proves the ack is ZK).
- **Gates:** `npm test`, `npx tsc --noEmit`, `npm run build`.

## Build order (for the plan)

1. Pure `src/lib/readiness.ts` + unit tests (TDD).
2. Prisma `ReadinessState` model + migration (both DBs) + `User` back-relation.
3. `src/app/api/readiness/state/route.ts` (GET/PUT) + api-client methods.
4. `useReadinessData` hook.
5. `readiness/page.tsx` + AppNav link.
6. Live e2e for the ack round-trip; final review.
