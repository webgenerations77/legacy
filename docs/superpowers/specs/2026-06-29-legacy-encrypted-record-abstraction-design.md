# Legacy — Sprint 2 Slice 3: Shared Encrypted-Record Abstraction — Design Spec

**Date:** 2026-06-29
**Scope:** A **behavior-preserving refactor** that extracts the duplicated machinery shared by the three zero-knowledge record types (Vault notes, Financial Accounts, Bills) into one server-side route factory and one client-side React hook. No new features, no schema changes.
**Status:** Approved design, pending implementation plan.

---

## 1. Goal & Non-Goals

### Goal
Eliminate the near-verbatim duplication that has accumulated across vault, accounts, and bills now that a third record type has landed (the trigger the prior specs named). Two new shared units — `createEncryptedRecordRoute` (server) and `useEncryptedRecords` (client) — become the single source of truth for the encrypted add-and-list pattern. Every future record type (mortgages, beneficiaries) then becomes a thin page + a one-line route, not another full copy.

**The defining constraint: this is a pure structural refactor.** Behavior is preserved exactly. Every existing unit test (18/18) and the live e2e (3/3) must pass **unchanged**. If a test would need editing to pass, behavior changed and the refactor is wrong.

### Non-Goals
- Config-driven UI (a field-schema DSL that renders forms/cards) — explicitly rejected as premature; presentation genuinely differs per type.
- Any new feature, field, validation rule, or copy change.
- Schema / migration changes — the three tables (`VaultItem`, `FinancialAccount`, `Bill`) are already identical in shape and stay as-is.
- Normalizing the API response keys — they are deliberately preserved (see §3).
- The security backlog (Argon2id, rate limiting, body-size cap, runtime `parse*` validation, `@@index([userId])`, etc.) — untouched here.

---

## 2. Current Duplication (what we're consolidating)

Three route files (`src/app/api/{vault,accounts,bills}/route.ts`) are identical except for the Prisma model and the JSON response key:
- A copy-pasted `requireUser()` helper (cookie → `getSessionUserId`).
- `GET`: `prisma.<model>.findMany({ where:{userId}, orderBy:{createdAt:"desc"}, select:{id,ciphertext,iv} })` → `{ <key>: rows }`.
- `POST`: `readJsonBody` → validate `ciphertext`/`iv` are non-empty strings → `prisma.<model>.create({ data:{userId,ciphertext,iv}, select:{id} })` → 201 `{ id }`.

Three pages (`src/app/{vault,accounts,bills}/page.tsx`) share the same control layer — `useKey` gate, `/unlock` redirect, `load()` (list → decrypt → parse), `onAdd` (encrypt → POST → reload), and the `error`/`loaded`/stale-error handling — but differ in presentation (form fields, card layout, and bills' sort + monthly summary).

`src/lib/api-client.ts` has six methods (`listVault`/`addVaultItem`/`listAccounts`/`addAccount`/`listBills`/`addBill`) that differ only by URL and response key.

---

## 3. Server: `createEncryptedRecordRoute`

New module `src/lib/encrypted-record-route.ts`:

```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import { readJsonBody } from "@/lib/http";

type RecordModel = "vaultItem" | "financialAccount" | "bill";

export function createEncryptedRecordRoute(opts: { model: RecordModel; listKey: string }): {
  GET: () => Promise<NextResponse>;
  POST: (req: Request) => Promise<NextResponse>;
};
```

Behavior, identical to today:
- `requireUser()` lives here once: reads `SESSION_COOKIE`, returns `getSessionUserId(sid)`.
- `GET` → 401 `{ error: "Unauthorized." }` when no user; else 200 `{ [listKey]: {id,ciphertext,iv}[] }` newest-first.
- `POST` → 401 when no user; `readJsonBody` 400 passthrough; 400 `{ error: "Missing fields." }` when `ciphertext`/`iv` missing or non-string; else 201 `{ id }`.

**Strict-safe model access:** `prisma[model]` is resolved through a small typed `switch` returning the concrete delegate (`prisma.vaultItem` | `prisma.financialAccount` | `prisma.bill`), not a dynamic string index — preserving `tsc --noEmit` cleanliness and `no any`.

**Response keys preserved (`items` / `accounts` / `bills`)** via `listKey`. This is the deliberate choice that keeps the e2e's `{ items }` / `{ accounts }` / `{ bills }` destructuring — and every consumer — working unchanged. Normalizing to one key would be a behavior change and is out of scope.

Each route file becomes one line, e.g.:
```ts
// src/app/api/bills/route.ts
import { createEncryptedRecordRoute } from "@/lib/encrypted-record-route";
export const { GET, POST } = createEncryptedRecordRoute({ model: "bill", listKey: "bills" });
```
(`vault` → `{ model: "vaultItem", listKey: "items" }`, `accounts` → `{ model: "financialAccount", listKey: "accounts" }`.)

---

## 4. Client: `useEncryptedRecords` hook

New client module `src/app/providers/useEncryptedRecords.ts`:

```ts
"use client";

export interface EncryptedRecordItem<T> {
  id: string;
  value: T | null; // null = this row failed to decrypt
}

export function useEncryptedRecords<T>(opts: {
  resource: "vault" | "accounts" | "bills"; // → /api/<resource>
  listKey: string;                          // response key to read
  serialize: (value: T) => string;
  parse: (json: string) => T;
}): {
  items: EncryptedRecordItem<T>[];
  error: string;
  loaded: boolean;
  add: (value: T) => Promise<void>; // serialize → encrypt → POST → reload
};
```

Internally the hook owns exactly what the three pages duplicate today:
- `useKey()` for `masterKey`; `useRouter()` for the `/unlock` redirect when `masterKey` is absent.
- `load()`: `api.listRecords(resource)` → for each row, `decryptItem(masterKey, ciphertext, iv)` then `parse`, mapping decrypt/parse failure to `value: null`; sets `items` and `loaded`; clears stale `error` on success.
- `add(value)`: `encryptItem(masterKey, serialize(value))` → `api.addRecord(resource, ciphertext, iv)` → `load()`; surfaces a calm `error` on failure.
- The same `useEffect([masterKey, load, router])` and `setError("")` clearing semantics as the current pages.

Errors use the same calm copy currently in each page. The hook does not own any presentation.

### api-client consolidation
`src/lib/api-client.ts` replaces the six named methods with a generic pair:
```ts
listRecords: (resource: string) =>
  /* GET /api/<resource>, throws calm error on !ok */ Promise<Record<string, unknown>>;
addRecord: (resource: string, ciphertext: string, iv: string) =>
  post<{ id: string }>(`/api/${resource}`, { ciphertext, iv });
```
The hook reads `response[listKey]` as the row array. (The existing `post<T>` helper and the auth methods stay.)

---

## 5. Page migration (presentation kept, control shed)

Each page keeps all its JSX and type-specific helpers; it swaps its hand-rolled state/effects for the hook.

| Page | Sheds to hook | Keeps (bespoke) |
|------|---------------|-----------------|
| `vault/page.tsx` | gate, load, decrypt, add, error/loaded | inline `.row` form; raw-string card |
| `accounts/page.tsx` | same | field form; account card; `maskAccountNumber` |
| `bills/page.tsx` | same | field form; bill card; `sortByDueDate` + `formatMoney(totalMonthly(...))` summary |

- **Vault** instantiates the hook with identity functions: `serialize: (s) => s`, `parse: (s) => s`, `T = string`. Its one behavior-equivalent change: the decrypt-failure message renders when `value === null` (today it substitutes the message as the item text). Same UX — calm message, rest of list still renders — now sourced from the null marker exactly as accounts/bills already do.
- **Accounts** passes `serializeAccount`/`parseAccount` (`T = Account`); card unchanged.
- **Bills** passes `serializeBill`/`parseBill` (`T = Bill`); derives `decryptedBills = items.map(i => i.value).filter(Boolean)` for the sort and summary exactly as today.

`encryptItem`/`decryptItem` (`src/lib/crypto.ts`) and `KeyProvider`/`useKey` are consumed unchanged.

---

## 6. Testing

- **Existing suite is the primary correctness proof — it must pass unchanged:** all current unit tests (18/18) and the live e2e (3/3 via `vitest.e2e.config.ts` against a running dev server + dev DB).
- **New unit tests** for the factory's request logic, the one seam newly worth isolating. Cover: 401 when `requireUser` yields no user (GET and POST), 400 when `ciphertext`/`iv` are missing or non-string (POST), 201 + `{ id }` on a valid POST, and the GET response shape `{ [listKey]: rows }`. Achieved by invoking the returned `GET`/`POST` with `getSessionUserId` and `prisma` mocked (Vitest module mocks), so the test needs no real DB. The exact mock seam is finalized in the plan.
- No new tests for the hook beyond what the existing page-level e2e already exercises end-to-end (a browser-driven hook test would be high-cost, low-value for a behavior-preserving change); manual smoke covers the UI.
- **Manual smoke** after migration: on all three pages, add a record, reload, confirm it decrypts and lists; confirm `/unlock` redirect when locked.
- **Gates:** `npx tsc --noEmit` clean, `npm run build` succeeds (all three routes + pages present), full unit suite green, live e2e green.

---

## 7. Global Constraints

- Zero-knowledge preserved exactly: server still stores/returns only `{ ciphertext, iv }` (+ `userId`, timestamps); all encrypt/decrypt stays client-side via the unchanged `crypto.ts`.
- Behavior-preserving: no change to API contracts (status codes, response keys, error copy), to stored data, or to user-visible UI beyond the single vault null-marker equivalence noted in §5.
- TypeScript strict; no `any`. Prisma model access is typed, not string-indexed.
- Reuse existing helpers unchanged: `getSessionUserId`, `readJsonBody`, `SESSION_COOKIE`, `prisma`, `encryptItem`/`decryptItem`, `KeyProvider`/`useKey`.
- Calm Legacy copy retained verbatim; `--alert`/`.error` for failures only.
- Migrations: none (no schema change).

---

## 8. Module Boundaries

| Unit | Does | Depends on |
|------|------|------------|
| `lib/encrypted-record-route.ts` | factory returning `{GET,POST}` for an encrypted-blob table | `prisma`, `getSessionUserId`, `SESSION_COOKIE`, `readJsonBody`, `next/server`, `next/headers` |
| `app/api/{vault,accounts,bills}/route.ts` | one-line route wiring (model + listKey) | `encrypted-record-route` |
| `app/providers/useEncryptedRecords.ts` | client hook owning gate/load/decrypt/add/error | `useKey`, `useRouter`, `api-client`, `crypto` |
| `lib/api-client.ts` | generic `listRecords`/`addRecord` (+ existing auth/post) | fetch |
| `app/{vault,accounts,bills}/page.tsx` | type-specific form + card; consume the hook | `useEncryptedRecords`, type lib (`account`/`bill`), `AppNav`, `Logo` |
