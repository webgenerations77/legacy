# Legacy — Sprint 2 Slice 2: Bills & Subscriptions (Walking Skeleton) — Design Spec

**Date:** 2026-06-28
**Scope:** A thin, end-to-end slice of **Bills & Subscriptions** that reuses the zero-knowledge machinery proven by the Vault (Sprint 1) and Financial Accounts (Sprint 2 Slice 1): add an encrypted bill record → list it → decrypt and display it, plus a small client-side **recurring-cost summary**. Second slice of Sprint 2 (Financial system).
**Status:** Approved design, pending implementation plan.

---

## 1. Goal & Non-Goals

### Goal
Capture a user's recurring payments (bills and subscriptions) as zero-knowledge encrypted records, so that — in survivor mode — someone can see **what recurring payments exist, how much, how often, when each is next due, and how to stop or continue them**. A bill is a 9-field object encrypted in the browser; the server stores only ciphertext. The `/bills` page adds two bill-specific touches over the Accounts list: it sorts by next due date and shows an estimated total monthly cost. All computation is client-side after decrypt.

### Non-Goals (later slices / sprints)
- Mortgages/loans and beneficiaries (later Sprint 2 slices).
- Edit / delete of bills (skeleton is add + list, matching the Vault and Accounts skeletons — kept at parity deliberately).
- Reminders, notifications, or calendar integration off `nextDueDate`.
- Linking a bill to a Financial Account record (cross-record references deferred).
- Currency/locale math beyond a simple monthly normalization; `amount` stays free-text.
- The shared **"encrypted records"** abstraction over vault + accounts + bills. Bills is the 3rd type and therefore the trigger for that refactor, but it is **deferred to its own dedicated slice** so this slice stays low-risk (decision confirmed during brainstorming).
- Any item from the security backlog (Argon2id, rate limiting, CSRF, indexes, runtime validation, etc.).

---

## 2. Architecture: reuse, don't reinvent

Bills ride entirely on the existing zero-knowledge foundation. **No new crypto, auth, key handling, or session logic.** This slice deliberately **mirrors the Financial Accounts slice** file-for-file rather than abstracting.

- A bill is a typed object: `{ name, category, amount, frequency, nextDueDate, paymentMethod, autoPay, website, notes }`.
- **Save:** browser does `serializeBill(bill)` (`JSON.stringify`) → `encryptItem(masterKey, json)` (existing crypto fn, unchanged) → `POST { ciphertext, iv }`.
- **Load:** browser gets `{ id, ciphertext, iv }[]` → `decryptItem` → `parseBill` (`JSON.parse`) → sorts by due date and renders, with a summary line computed across the decrypted set.
- The server stores only `ciphertext + iv` (+ `userId`, timestamps). It never sees the name, amount, frequency, or due date. Identical guarantee to the vault and accounts.

The master key remains in-memory only (the existing `KeyProvider`); a reload routes to `/unlock`.

Deliberate choice: a **parallel** `Bill` table + `/api/bills` routes + `/bills` page rather than refactoring vault + accounts + bills into one abstraction now. Duplication is acknowledged and accepted for this slice; the refactor is its own follow-up.

---

## 3. Data Model (Prisma)

New model, mirroring `FinancialAccount` / `VaultItem` (opaque blobs only):

```prisma
model Bill {
  id         String   @id @default(cuid())
  userId     String
  ciphertext String   // base64 AES-GCM of the JSON bill object
  iv         String
  createdAt  DateTime @default(now())
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

Add `bills Bill[]` to `User`. A new migration is applied to **both** the dev (`.env`) and test (`.env.test`) databases (same flow as prior slices).

The bill record stored inside `ciphertext` (never in plaintext columns):

| Field | Type | UI | Notes |
|---|---|---|---|
| `name` | string | text | e.g. "Netflix", "Electric" (display title; required on add) |
| `category` | string (enum-ish) | dropdown | Utility / Streaming / Insurance / Loan / Subscription / Other |
| `amount` | string | text | free text for the skeleton (no currency math beyond normalization) |
| `frequency` | string (enum-ish) | dropdown | Weekly / Monthly / Quarterly / Annual / One-time |
| `nextDueDate` | string | date input | ISO `YYYY-MM-DD` or `""`; blanks sort last |
| `paymentMethod` | string | text | e.g. "Visa ••1234", "Checking" |
| `autoPay` | boolean | checkbox | whether the payment is automatic |
| `website` | string | text | where to manage/cancel |
| `notes` | string | textarea | optional |

---

## 4. API (Next.js route handlers)

`src/app/api/bills/route.ts` — session-gated and tenant-scoped, reusing existing `getSessionUserId`, the `requireUser` pattern, `SESSION_COOKIE`, and `readJsonBody`. A literal parallel of `src/app/api/accounts/route.ts`:

| Method | Contract |
|---|---|
| `GET /api/bills` | → 200 `{ bills: { id, ciphertext, iv }[] }` newest first; 401 if no valid session |
| `POST /api/bills` | body `{ ciphertext, iv }` → 201 `{ id }`; 400 if a field is missing/non-string; 401 if no valid session |

Both handlers resolve `userId` from the session and scope every query to it (no cross-user access). Server-side order is `createdAt desc`; the bill-specific due-date sort happens client-side after decrypt (the server cannot read due dates).

**API client additions** (`src/lib/api-client.ts`):
- `listBills(): Promise<{ bills: { id: string; ciphertext: string; iv: string }[] }>`
- `addBill(ciphertext: string, iv: string): Promise<{ id: string }>`

---

## 5. Domain module (`src/lib/bill.ts`)

Pure, testable, no crypto/IO:

```ts
export type Frequency = "Weekly" | "Monthly" | "Quarterly" | "Annual" | "One-time";
export type BillCategory =
  | "Utility" | "Streaming" | "Insurance" | "Loan" | "Subscription" | "Other";

export interface Bill {
  name: string;
  category: BillCategory;
  amount: string;
  frequency: Frequency;
  nextDueDate: string;   // "YYYY-MM-DD" or ""
  paymentMethod: string;
  autoPay: boolean;
  website: string;
  notes: string;
}

export function serializeBill(b: Bill): string;        // JSON.stringify
export function parseBill(json: string): Bill;          // JSON.parse (typed)
export function monthlyAmount(b: Bill): number;         // normalize amount → per-month
export function totalMonthly(bills: Bill[]): number;    // sum of monthlyAmount
export function formatMoney(n: number): string;         // e.g. "$247"
export function sortByDueDate(bills: Bill[]): Bill[];    // ascending; blanks last
```

Behavioral details:
- `monthlyAmount`: parse `amount` defensively — strip any non-numeric leading characters (`$`, spaces) and thousands separators (`,`) before `parseFloat`; non-numeric or empty → `0`. Then scale by frequency: Weekly `× 52/12`, Monthly `× 1`, Quarterly `÷ 3`, Annual `÷ 12`, One-time → `0` (a one-time payment is not a recurring monthly cost).
- `totalMonthly`: sum of `monthlyAmount` over the array; `[]` → `0`.
- `formatMoney`: rounds to a whole dollar for the summary line (e.g. `"$247"`). No locale/currency-symbol configuration in this slice.
- `sortByDueDate`: ascending by `nextDueDate` string compare (ISO dates sort lexically); empty `nextDueDate` sorts **after** all dated bills. Pure — returns a new array, does not mutate input.

---

## 6. UI & Navigation

- **`src/app/bills/page.tsx`** (client, gated by `useKey` exactly like `/vault` and `/accounts`): an add form (name + category dropdown + amount + frequency dropdown + date input + payment method + auto-pay checkbox + website + notes) and a decrypted list.
  - **Summary line** above the list: *"Estimated ~$247/mo across N bills"* using `formatMoney(totalMonthly(...))` over successfully-decrypted bills. Hidden until at least one bill decrypts.
  - **List**, sorted by `sortByDueDate`: each card shows **name** (title); a meta line of **category · frequency · due {nextDueDate}**; **amount**; an **"Auto-pay"** tag when `autoPay`; **payment method**; **website**; **notes**. Empty fields are omitted (same conditional-render style as the Accounts card).
- **`AppNav`** (`src/components/AppNav.tsx`): add a **Bills** link → calm text links become **Vault · Accounts · Bills** + **Lock & sign out**. Placed atop `/bills` as on the other pages.
- Styling reuses the existing design-system classes (`.card`, `.item`, `.meta`, `.notes`, `.subtle`, `.error`, `.appnav`, form/label styles). A small new class only if needed for the auto-pay tag or summary line.

---

## 7. Error Handling (mirrors the vault/accounts, calm tone)
- Save failure → generic message (e.g. *"We couldn't save that. Please try again."*).
- Per-bill decrypt failure → that card shows *"We couldn't unlock this bill."*; the rest of the list still renders, and the failed card is excluded from the monthly total.
- Lost master key / expired session → redirect to `/unlock`.
- Bill-list load failure → calm inline message (not a silent empty list), clearing any stale error on success.

---

## 8. Testing
- **TDD** for `src/lib/bill.ts`:
  - `serializeBill` → `parseBill` round-trip returns the original object (including `autoPay` boolean).
  - `monthlyAmount` for each frequency (Weekly, Monthly, Quarterly, Annual, One-time) and for a non-numeric/empty amount (→ 0).
  - `totalMonthly` over a mixed-frequency set and over `[]` (→ 0).
  - `sortByDueDate`: dated bills ascending, blank `nextDueDate` last, input not mutated.
  - `formatMoney` rounding.
- **Extend the live e2e** (`e2e.spec.ts`): authenticated client creates an encrypted bill via `POST /api/bills` → `GET` lists it → decrypt + `parseBill` → assert fields match; assert the stored DB row's `ciphertext` contains **no** plaintext (bill name and amount absent).
- Gates: `npx tsc --noEmit` clean, `npm run build` succeeds, full unit suite green.

---

## 9. Global Constraints (inherited from prior slices)
- Zero-knowledge: passphrase/master key/plaintext never reach the server; server persists only ciphertext, IVs, and the existing auth data.
- Reuse the existing `encryptItem`/`decryptItem` (no changes), `KeyProvider`/`useKey`, `getSessionUserId`, `readJsonBody`, `SESSION_COOKIE`.
- TypeScript strict; no `any` in committed code.
- Calm, supportive copy per the Legacy design system; `--alert` color for errors only.
- Migrations applied to both dev (`.env`) and test (`.env.test`) databases.
- After adding the API route, clear `.next` and restart `npm run dev` if `/api/*` 404s (known Turbopack stale-cache gotcha).

---

## 10. Module Boundaries (new units)

| Unit | Does | Depends on |
|------|------|------------|
| `lib/bill.ts` | bill type + serialize/parse + monthly normalization + total + sort + money format (pure) | nothing |
| `app/api/bills/route.ts` | list/create encrypted bill rows | `@/lib/db`, `@/lib/auth`, `@/lib/session-cookie`, `@/lib/http` |
| `api-client` additions | typed `listBills`/`addBill` | fetch |
| `app/bills/page.tsx` | bill add form + decrypted, due-sorted list + monthly summary | `KeyProvider`, `api-client`, `lib/crypto`, `lib/bill` |
| `components/AppNav.tsx` | cross-page nav (adds Bills link) + lock/sign out | `api-client`, `KeyProvider`, `next/navigation` |
| Prisma `Bill` | persistence of opaque blobs | Postgres |
