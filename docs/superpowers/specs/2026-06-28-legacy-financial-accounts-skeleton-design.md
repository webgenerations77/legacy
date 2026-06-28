# Legacy — Sprint 2 Slice 1: Financial Accounts (Walking Skeleton) — Design Spec

**Date:** 2026-06-28
**Scope:** A thin, end-to-end slice of **Financial Accounts** that reuses the Sprint 1 zero-knowledge machinery: add an encrypted account record → list it → decrypt and display it. First slice of Sprint 2 (Financial system).
**Status:** Approved design, pending implementation plan.

---

## 1. Goal & Non-Goals

### Goal
Prove the zero-knowledge vault pattern generalizes from a single note string to a **structured record**. A user can add a financial account (a 6-field object), see it listed (decrypted in the browser), with the server storing only ciphertext — reusing the existing crypto, key context, auth, and session machinery unchanged.

### Non-Goals (later slices / sprints)
- Bills & subscriptions, mortgages/loans, beneficiaries (later Sprint 2 slices)
- Edit / delete of accounts (skeleton is add + list, mirroring the vault skeleton)
- Currency math, totals, dashboards, the Legacy Completion Score
- Server-side querying/sorting on account contents (everything is opaque ciphertext)
- A shared "encrypted records" abstraction over vault + accounts (deliberately deferred — YAGNI; extract later if a third type appears)

---

## 2. Architecture: reuse, don't reinvent

Financial accounts ride entirely on the Sprint 1 zero-knowledge foundation. **No new crypto, auth, key handling, or session logic.**

- An account is a typed object: `{ type, institution, nickname, accountNumber, balance, notes }`.
- **Save:** browser does `serializeAccount(account)` (`JSON.stringify`) → `encryptItem(masterKey, json)` (existing crypto fn, unchanged) → `POST { ciphertext, iv }`.
- **Load:** browser gets `{ id, ciphertext, iv }[]` → `decryptItem` → `parseAccount` (`JSON.parse`) → renders fields.
- The server stores only `ciphertext + iv` (+ `userId`, timestamps). It never sees type, institution, number, or balance. Identical guarantee to the vault.

The master key remains in-memory only (the existing `KeyProvider`); a reload routes to `/unlock`.

Deliberate choice: a **parallel** `FinancialAccount` table + `/api/accounts` routes rather than refactoring vault + accounts into one abstraction now. Duplication is small; each file stays simple and independently understandable.

---

## 3. Data Model (Prisma)

New model, mirroring `VaultItem` (opaque blobs only):

```prisma
model FinancialAccount {
  id         String   @id @default(cuid())
  userId     String
  ciphertext String   // base64 AES-GCM of the JSON account object
  iv         String
  createdAt  DateTime @default(now())
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

Add `financialAccounts FinancialAccount[]` to `User`. A new migration is applied to **both** the dev and test databases (same flow as Sprint 1).

The account record stored inside `ciphertext` (never in plaintext columns):

| Field | Type | UI | Notes |
|---|---|---|---|
| `type` | string (enum-ish) | dropdown | Checking / Savings / Investment / Retirement / Other |
| `institution` | string | text | e.g. "First National Bank" |
| `nickname` | string | text | display title |
| `accountNumber` | string | text | masked to last-4 on display only |
| `balance` | string | text | free text for the skeleton (no currency math) |
| `notes` | string | textarea | optional |

---

## 4. API (Next.js route handlers)

`src/app/api/accounts/route.ts` — session-gated and tenant-scoped, reusing existing `getSessionUserId`, the `requireUser` pattern, `SESSION_COOKIE`, and `readJsonBody`:

| Method | Contract |
|---|---|
| `GET /api/accounts` | → 200 `{ accounts: { id, ciphertext, iv }[] }` newest first; 401 if no valid session |
| `POST /api/accounts` | body `{ ciphertext, iv }` → 201 `{ id }`; 400 if a field is missing/non-string; 401 if no valid session |

Both handlers resolve `userId` from the session and scope every query to it (no cross-user access). Mirrors `src/app/api/vault/route.ts`.

**API client additions** (`src/lib/api-client.ts`):
- `listAccounts(): Promise<{ accounts: { id: string; ciphertext: string; iv: string }[] }>`
- `addAccount(ciphertext: string, iv: string): Promise<{ id: string }>`

---

## 5. Domain module (`src/lib/account.ts`)

Pure, testable, no crypto/IO:

```ts
export type AccountType = "Checking" | "Savings" | "Investment" | "Retirement" | "Other";
export interface Account {
  type: AccountType;
  institution: string;
  nickname: string;
  accountNumber: string;
  balance: string;
  notes: string;
}
export function serializeAccount(a: Account): string;     // JSON.stringify
export function parseAccount(json: string): Account;       // JSON.parse (typed)
export function maskAccountNumber(value: string): string;  // last 4 → "••••4821"; short/empty handled
```

`maskAccountNumber`: returns `""` for empty; if length ≤ 4, returns the value as-is; otherwise `"••••" + last4`.

---

## 6. UI & Navigation

- **`src/app/accounts/page.tsx`** (client, gated by `useKey` exactly like `/vault`): an add form (type dropdown + 5 inputs/textarea) and a decrypted list. List card shows **nickname** (title), **type · institution**, **masked account number**, **balance**, **notes**.
- **`AppNav`** (`src/components/AppNav.tsx`): calm text links **Vault · Accounts** + **Lock & sign out** (the existing logout behavior moves here), placed atop both `/vault` and `/accounts`. Post-unlock still lands on `/vault`.
- Styling reuses the existing design-system classes (`.card`, `.row`, `.item`, `.link`, `.linkbtn`, `.error`, form/label styles). New small classes only if needed for the nav.

---

## 7. Error Handling (mirrors the vault, calm tone)
- Save failure → generic message (e.g. *"We couldn't save that. Please try again."*).
- Per-account decrypt failure → that card shows *"We couldn't unlock this account."*; the rest of the list still renders.
- Lost master key / expired session → redirect to `/unlock`.
- Account-list load failure → calm inline message (not a silent empty list).

---

## 8. Testing
- **TDD** for `src/lib/account.ts`: serialize → parse round-trip returns the original object; `maskAccountNumber` for normal (last-4), ≤4-char, and empty inputs.
- **Extend the live e2e** (`e2e.spec.ts`): authenticated client creates an encrypted account via `POST /api/accounts` → `GET` lists it → decrypt + `parseAccount` → assert fields match; assert the stored DB row's `ciphertext` contains **no** plaintext (institution and account number absent).
- Gates: `npx tsc --noEmit` clean, `npm run build` succeeds, full unit suite green.

---

## 9. Global Constraints (inherited from Sprint 1)
- Zero-knowledge: passphrase/master key/plaintext never reach the server; server persists only ciphertext, IVs, and the existing auth data.
- Reuse the existing `encryptItem`/`decryptItem` (no changes), `KeyProvider`/`useKey`, `getSessionUserId`, `readJsonBody`, `SESSION_COOKIE`.
- TypeScript strict; no `any` in committed code.
- Calm, supportive copy per the Legacy design system; `--alert` color for errors only.
- Migrations applied to both dev (`.env`) and test (`.env.test`) databases.

---

## 10. Module Boundaries (new units)

| Unit | Does | Depends on |
|------|------|------------|
| `lib/account.ts` | account type + serialize/parse + mask (pure) | nothing |
| `app/api/accounts/route.ts` | list/create encrypted account rows | `@/lib/db`, `@/lib/auth`, `@/lib/session-cookie`, `@/lib/http` |
| `api-client` additions | typed `listAccounts`/`addAccount` | fetch |
| `app/accounts/page.tsx` | account add form + decrypted list | `KeyProvider`, `api-client`, `lib/crypto`, `lib/account` |
| `components/AppNav.tsx` | cross-page nav + lock/sign out | `api-client`, `KeyProvider`, `next/navigation` |
| Prisma `FinancialAccount` | persistence of opaque blobs | Postgres |
