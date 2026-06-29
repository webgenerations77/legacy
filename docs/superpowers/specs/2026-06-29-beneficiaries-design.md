# Beneficiaries slice — design

**Date:** 2026-06-29
**Status:** Approved (design phase)

The fifth encrypted-record type, built on the shared encrypted-record abstraction
(domain lib + Prisma model + `createEncryptedRecordRoute` + `useEncryptedRecords`
page + nav link). Mirrors the Loans/Mortgages slice precisely. The zero-knowledge
invariant is preserved: the server only ever stores `{ ciphertext, iv }` blobs; all
encrypt/decrypt happens client-side.

## Data model — `src/lib/beneficiary.ts`

```ts
export type BeneficiaryRelationship =
  | "Spouse" | "Child" | "Parent" | "Sibling"
  | "Friend" | "Trust" | "Charity" | "Other";

export interface Beneficiary {
  fullName: string;                       // required
  relationship: BeneficiaryRelationship;  // required
  email: string;                          // optional ("")
  phone: string;                          // optional ("")
  mailingAddress: string;                 // optional ("")
  allocation: string;                     // optional ("") — percent as string, e.g. "50"
  notes: string;                          // optional ("")
}

export function serializeBeneficiary(b: Beneficiary): string {
  return JSON.stringify(b);
}

export function parseBeneficiary(json: string): Beneficiary {
  return JSON.parse(json) as Beneficiary;
}
```

`allocation` is stored as a string (consistent with how loans store monetary
amounts), parsed defensively in the helpers below.

## Display helpers

- `totalAllocation(beneficiaries: Beneficiary[]): number` — sums `allocation`
  defensively (`parseFloat`, ignoring blanks and `NaN`).
- `allocationStatus(total: number): "balanced" | "under" | "over"` —
  `=== 100` → `"balanced"`, `< 100` → `"under"`, `> 100` → `"over"`.
- `sortByAllocationDesc(beneficiaries: Beneficiary[]): Beneficiary[]` — largest
  share first; ties broken by `fullName` (locale compare). Non-mutating.
- `maskContact(value: string): string` — masks an email (`j***@example.com`) or
  a phone/other string (keep a small visible suffix), mirroring
  `maskAccountNumber`. Empty input returns `""`.

## Prisma model + migration

Add to `prisma/schema.prisma`:

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

Add `beneficiaries Beneficiary[]` to the `User` model.

One migration `prisma/migrations/<timestamp>_beneficiaries/migration.sql` with
`CREATE TABLE "Beneficiary"` + the foreign key (same shape as the loans
migration). Applied to **both** dev (`.env`) and test (`.env.test`) DBs and
committed as a file so the pipeline applies it.

## Route

In `src/lib/encrypted-record-route.ts`: add `"beneficiary"` to the `RecordModel`
union and a `case "beneficiary"` to the delegate switch.

`src/app/api/beneficiaries/route.ts`:

```ts
import { createEncryptedRecordRoute } from "@/lib/encrypted-record-route";

export const { GET, POST } = createEncryptedRecordRoute({
  model: "beneficiary",
  listKey: "beneficiaries",
});
```

## Page — `src/app/beneficiaries/page.tsx`

`"use client"` component consuming the generic hook:

```ts
const { items, error, loaded, add, masterKey } = useEncryptedRecords<Beneficiary>({
  resource: "beneficiaries",
  listKey: "beneficiaries",
  serialize: serializeBeneficiary,
  parse: parseBeneficiary,
  noun: "beneficiaries",
});
```

Form fields: full name (text, required), relationship (select, required), email,
phone, mailing address, allocation % (number-ish text), notes (textarea). Only
**name and relationship are required**; the rest may be left blank.

Cards: sorted by `sortByAllocationDesc`, contact masked via `maskContact`, with a
summary line showing `totalAllocation` and the `allocationStatus`
(e.g. "Allocated: 90% — 10% unassigned" / "Allocated: 100%" / "Over-allocated by
10%"). Same loaded / empty / error / decryption-failure states as the loans page.

## Nav

Add `<Link href="/beneficiaries">Beneficiaries</Link>` to
`src/components/AppNav.tsx` after the Loans link.

## Testing

- **Unit** `src/lib/beneficiary.test.ts` (mirrors `loan.test.ts`): serialize/parse
  round-trip; `totalAllocation` defensive summing; `allocationStatus` thresholds
  (99/100/101); `sortByAllocationDesc` ordering + tie-break + non-mutation;
  `maskContact` for email, phone, and empty input.
- **Live e2e** (added to `e2e.spec.ts`, run via `vitest.e2e.config.ts`): register +
  login a fresh user → encrypt a beneficiary client-side → POST `/api/beneficiaries`
  (expect 201) → GET (expect `{ beneficiaries: [...] }`) → decrypt + `parseBeneficiary`
  → assert exact round-trip → query DB directly and assert the ciphertext contains
  no plaintext name/email → cleanup `db.user.delete()`.

The `useEncryptedRecords` hook is already generic — no changes.

## Verification gates

`npm test` (unit) → `npx tsc --noEmit` (typecheck) → `npm run build` → live e2e
(`npx vitest run --config vitest.e2e.config.ts` against a running `npm run dev` +
dev DB).
