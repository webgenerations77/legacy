# Conversational Edit/Delete + Mutation Foundation (Slice B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-record edit and delete to the (currently append-only) encrypted-record pattern — plain Delete buttons on every per-type page, and conversational edit by pinning one record into `/assistant`.

**Architecture:** A new `createEncryptedRecordItemRoute` factory exposes ownership-scoped `PUT`/`DELETE` (`updateMany`/`deleteMany` on `where:{id,userId}`) behind five `[id]` routes. Delete is a plain inline-confirm button. Edit deep-links a record into `/assistant`, which decrypts that one record, sends its current fields to the model as edit context, and reuses Slice A's `proposeRecord` tool + `ProposalCard`; `confirmProposal` branches POST (create) vs PUT (edit).

**Tech Stack:** Next.js 16 (App Router, TS strict), Prisma 6, AI SDK `ai@7.0.7` + `@ai-sdk/react@4.0.8`, WebCrypto (`src/lib/crypto.ts`), Vitest (node env).

## Global Constraints

- **Zero-knowledge:** server persists only `{ ciphertext, iv }`; master key never leaves the browser. Delete sends only the record id (no content). Edit sends exactly ONE user-pinned record's decrypted fields to the model as context; the updated record is re-encrypted client-side before PUT. Chat route still persists nothing; transcript ephemeral.
- **Ownership is mandatory on every mutation:** `PUT`/`DELETE` scope by `where: { id, userId }` via `updateMany`/`deleteMany`; a zero `count` → **404**. Never `update`/`delete` by id alone (that would let one user touch another's row).
- **Reuse, don't duplicate:** `createEncryptedRecordItemRoute` mirrors `createEncryptedRecordRoute`'s auth/validation; the `ProposalCard` is reused verbatim; `confirmProposal` gains ONE branch, not a parallel path; the five pages share ONE `RecordActions` component for the Delete/Edit affordances.
- **No `window.confirm`/`alert`:** delete confirmation is an inline two-step in component state (those dialogs block the page/event loop).
- **No new dependencies, no Prisma migration** (`updateMany`/`deleteMany` use existing columns). No new env vars.
- **Test harness reality:** Vitest is `environment: "node"`, no React Testing Library. Automated tests cover pure libs + node-side routes only. Hooks, components, pages, and the live edit conversation are verified manually (`npm run dev`), consistent with Slice A.
- **Per `AGENTS.md`:** confirm the Next 16 dynamic-route handler signature (`ctx.params` is a `Promise`) and the `@ai-sdk/react` per-message `body` mechanism against the installed packages before writing those pieces.
- **Gates (every task):** `npm test`, `npx tsc --noEmit`, `npm run build`.

## File Structure

- `src/lib/assistant/record-schemas.ts` (modify) — add `parseToFields`.
- `src/lib/assistant/record-schemas.test.ts` (modify) — `parseToFields` tests.
- `src/lib/encrypted-record-item-route.ts` (create) — `createEncryptedRecordItemRoute` (PUT/DELETE).
- `src/lib/encrypted-record-item-route.test.ts` (create) — factory tests.
- `src/app/api/{accounts,bills,loans,beneficiaries,vault}/[id]/route.ts` (create ×5) — one-liners.
- `src/lib/api-client.ts` (modify) — `updateRecord`, `deleteRecord`.
- `src/app/providers/useEncryptedRecords.ts` (modify) — `remove(id)`.
- `src/components/RecordActions.tsx` (create) — shared Edit-link + inline-confirm Delete.
- `src/app/{accounts,bills,loans,beneficiaries,vault}/page.tsx` (modify ×5) — drop in `RecordActions`.
- `src/app/api/assistant/chat/route.ts` (modify) — optional `editContext` → system prompt.
- `src/app/api/assistant/chat/route.test.ts` (modify) — editContext test.
- `src/app/providers/useEditTarget.ts` (create) — load + decrypt the pinned record → `EditTarget`.
- `src/app/providers/useAssistant.ts` (modify) — edit-awareness (`editTarget` param).
- `src/app/assistant/page.tsx` (modify) — edit-mode banner, Delete, merged card.

---

### Task 1: `parseToFields` (inverse of `toPlaintext`)

**Files:**
- Modify: `src/lib/assistant/record-schemas.ts`
- Test: `src/lib/assistant/record-schemas.test.ts`

**Interfaces:**
- Consumes: existing `parseAccount`/`parseBill`/`parseLoan`/`parseBeneficiary` (already imported as `serialize*` siblings — add the `parse*` imports), `RECORD_SCHEMA_BY_KEY`, `ProposedFields`, `RecordTypeKey`.
- Produces: `function parseToFields(type: RecordTypeKey, plaintext: string): ProposedFields`

- [ ] **Step 1: Write the failing test** (append to `record-schemas.test.ts`)

```ts
import { parseToFields } from "@/lib/assistant/record-schemas";

describe("parseToFields", () => {
  it("round-trips with toPlaintext for an account (incl. type → accountType)", () => {
    const fields = { institution: "Chase", accountType: "Savings", balance: "100" };
    const pt = toPlaintext("account", fields);
    const back = parseToFields("account", pt);
    expect(back.institution).toBe("Chase");
    expect(back.accountType).toBe("Savings"); // domain `.type` mapped back to field key
    expect(back.balance).toBe("100");
  });

  it("round-trips a bill's boolean autoPay", () => {
    const pt = toPlaintext("bill", { name: "Netflix", autoPay: true });
    const back = parseToFields("bill", pt);
    expect(back.name).toBe("Netflix");
    expect(back.autoPay).toBe(true);
  });

  it("maps vault plaintext to a note field", () => {
    expect(parseToFields("vault", "the safe code is 1234")).toEqual({ note: "the safe code is 1234" });
  });

  it("round-trips loan and beneficiary required fields", () => {
    expect(parseToFields("loan", toPlaintext("loan", { lender: "Wells Fargo" })).lender).toBe("Wells Fargo");
    expect(parseToFields("beneficiary", toPlaintext("beneficiary", { fullName: "Sam Lee" })).fullName).toBe("Sam Lee");
  });

  it("degrades to {} on malformed non-vault plaintext rather than throwing", () => {
    expect(parseToFields("account", "not json{")).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/assistant/record-schemas.test.ts`
Expected: FAIL — `parseToFields` is not exported.

- [ ] **Step 3: Implement** (add to `record-schemas.ts`; add `parseAccount`,`parseBill`,`parseLoan`,`parseBeneficiary` to the existing imports from the domain libs)

```ts
// Inverse of toPlaintext: stored plaintext → editable ProposedFields (field keys).
// The account domain object's `.type` maps back to the `accountType` field key
// (the discriminant-collision fix from Slice A, in reverse). Vault is a raw string.
export function parseToFields(type: RecordTypeKey, plaintext: string): ProposedFields {
  if (type === "vault") return { note: plaintext };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(plaintext) as Record<string, unknown>;
  } catch {
    return {};
  }
  const fields: ProposedFields = {};
  for (const f of RECORD_SCHEMA_BY_KEY[type].fields) {
    // account's "accountType" field reads from the domain object's "type" key.
    const sourceKey = type === "account" && f.key === "accountType" ? "type" : f.key;
    const v = obj[sourceKey];
    if (typeof v === "string" || typeof v === "boolean") fields[f.key] = v;
  }
  return fields;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/assistant/record-schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` (clean)
```bash
git add src/lib/assistant/record-schemas.ts src/lib/assistant/record-schemas.test.ts
git commit -m "feat: add parseToFields (inverse of toPlaintext) for edit pre-fill"
```

---

### Task 2: `createEncryptedRecordItemRoute` factory (PUT/DELETE)

**Files:**
- Create: `src/lib/encrypted-record-item-route.ts`
- Test: `src/lib/encrypted-record-item-route.test.ts`

**Interfaces:**
- Consumes: `prisma` from `@/lib/db`; `getSessionUserId` from `@/lib/auth`; `SESSION_COOKIE` from `@/lib/session-cookie`; `readJsonBody` from `@/lib/http`; `cookies` from `next/headers`. (Mirror `src/lib/encrypted-record-route.ts`.)
- Produces: `createEncryptedRecordItemRoute(opts: { model: "vaultItem" | "financialAccount" | "bill" | "loan" | "beneficiary" }): { PUT, DELETE }` where each handler is `(req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<NextResponse>`.

**Verify first (AGENTS.md):** confirm Next 16's dynamic route handler receives `ctx.params` as a `Promise` (check a guide under `node_modules/next/dist/docs/` or existing usage). The code below `await ctx.params`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/encrypted-record-item-route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const getSessionUserId = vi.fn();
const updateMany = vi.fn();
const deleteMany = vi.fn();

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "sid-123" }) }),
}));
vi.mock("@/lib/auth", () => ({
  getSessionUserId: (...a: unknown[]) => getSessionUserId(...a),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    bill: {
      updateMany: (...a: unknown[]) => updateMany(...a),
      deleteMany: (...a: unknown[]) => deleteMany(...a),
    },
  },
}));

import { createEncryptedRecordItemRoute } from "@/lib/encrypted-record-item-route";

const { PUT, DELETE } = createEncryptedRecordItemRoute({ model: "bill" });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const putReq = (body: unknown) =>
  new Request("http://localhost/api/bills/abc", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const delReq = () => new Request("http://localhost/api/bills/abc", { method: "DELETE" });

beforeEach(() => {
  getSessionUserId.mockReset();
  updateMany.mockReset();
  deleteMany.mockReset();
});

describe("createEncryptedRecordItemRoute", () => {
  it("PUT 401 when unauthenticated; delegate not called", async () => {
    getSessionUserId.mockResolvedValue(null);
    const res = await PUT(putReq({ ciphertext: "c", iv: "i" }), ctx("abc"));
    expect(res.status).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("PUT 400 when ciphertext/iv missing or non-string", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    expect((await PUT(putReq({ ciphertext: "c" }), ctx("abc"))).status).toBe(400);
    expect((await PUT(putReq({ ciphertext: 1, iv: "i" }), ctx("abc"))).status).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("PUT 404 when no row matches {id, userId}", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    updateMany.mockResolvedValue({ count: 0 });
    const res = await PUT(putReq({ ciphertext: "c", iv: "i" }), ctx("abc"));
    expect(res.status).toBe(404);
  });

  it("PUT 200 updates the owned row", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    updateMany.mockResolvedValue({ count: 1 });
    const res = await PUT(putReq({ ciphertext: "c2", iv: "i2" }), ctx("abc"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "abc", userId: "user-1" },
      data: { ciphertext: "c2", iv: "i2" },
    });
  });

  it("DELETE 401 unauth; 404 on no match; 200 on success", async () => {
    getSessionUserId.mockResolvedValue(null);
    expect((await DELETE(delReq(), ctx("abc"))).status).toBe(401);

    getSessionUserId.mockResolvedValue("user-1");
    deleteMany.mockResolvedValue({ count: 0 });
    expect((await DELETE(delReq(), ctx("abc"))).status).toBe(404);

    deleteMany.mockResolvedValue({ count: 1 });
    const ok = await DELETE(delReq(), ctx("abc"));
    expect(ok.status).toBe(200);
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "abc", userId: "user-1" } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/encrypted-record-item-route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/encrypted-record-item-route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import { readJsonBody } from "@/lib/http";

type RecordModel = "vaultItem" | "financialAccount" | "bill" | "loan" | "beneficiary";

interface BlobItemDelegate {
  updateMany(args: {
    where: { id: string; userId: string };
    data: { ciphertext: string; iv: string };
  }): Promise<{ count: number }>;
  deleteMany(args: { where: { id: string; userId: string } }): Promise<{ count: number }>;
}

async function requireUser(): Promise<string | null> {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  return getSessionUserId(sid);
}

export function createEncryptedRecordItemRoute(opts: { model: RecordModel }) {
  const delegate = ((): BlobItemDelegate => {
    switch (opts.model) {
      case "vaultItem":
        return prisma.vaultItem as unknown as BlobItemDelegate;
      case "financialAccount":
        return prisma.financialAccount as unknown as BlobItemDelegate;
      case "bill":
        return prisma.bill as unknown as BlobItemDelegate;
      case "loan":
        return prisma.loan as unknown as BlobItemDelegate;
      case "beneficiary":
        return prisma.beneficiary as unknown as BlobItemDelegate;
    }
  })();

  async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const userId = await requireUser();
    if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = await readJsonBody(req);
    if (body instanceof NextResponse) return body;
    const ciphertext = typeof body.ciphertext === "string" ? body.ciphertext : "";
    const iv = typeof body.iv === "string" ? body.iv : "";
    if (!ciphertext || !iv) {
      return NextResponse.json({ error: "Missing fields." }, { status: 400 });
    }

    const { id } = await ctx.params;
    const { count } = await delegate.updateMany({
      where: { id, userId },
      data: { ciphertext, iv },
    });
    if (count === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
    const userId = await requireUser();
    if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const { id } = await ctx.params;
    const { count } = await delegate.deleteMany({ where: { id, userId } });
    if (count === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  return { PUT, DELETE };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/encrypted-record-item-route.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Gates + commit**

Run: `npm test && npx tsc --noEmit`
```bash
git add src/lib/encrypted-record-item-route.ts src/lib/encrypted-record-item-route.test.ts
git commit -m "feat: add ownership-scoped PUT/DELETE encrypted-record item route factory"
```

---

### Task 3: Five `[id]` routes + api-client methods

**Files:**
- Create: `src/app/api/accounts/[id]/route.ts`, `src/app/api/bills/[id]/route.ts`, `src/app/api/loans/[id]/route.ts`, `src/app/api/beneficiaries/[id]/route.ts`, `src/app/api/vault/[id]/route.ts`
- Modify: `src/lib/api-client.ts`

**Interfaces:**
- Consumes: `createEncryptedRecordItemRoute` (Task 2).
- Produces: `api.updateRecord(resource, id, ciphertext, iv): Promise<{ ok: true }>`, `api.deleteRecord(resource, id): Promise<{ ok: true }>`.

- [ ] **Step 1: Create the five route files** (model per resource)

```ts
// src/app/api/accounts/[id]/route.ts
import { createEncryptedRecordItemRoute } from "@/lib/encrypted-record-item-route";
export const { PUT, DELETE } = createEncryptedRecordItemRoute({ model: "financialAccount" });
```
```ts
// src/app/api/bills/[id]/route.ts
import { createEncryptedRecordItemRoute } from "@/lib/encrypted-record-item-route";
export const { PUT, DELETE } = createEncryptedRecordItemRoute({ model: "bill" });
```
```ts
// src/app/api/loans/[id]/route.ts
import { createEncryptedRecordItemRoute } from "@/lib/encrypted-record-item-route";
export const { PUT, DELETE } = createEncryptedRecordItemRoute({ model: "loan" });
```
```ts
// src/app/api/beneficiaries/[id]/route.ts
import { createEncryptedRecordItemRoute } from "@/lib/encrypted-record-item-route";
export const { PUT, DELETE } = createEncryptedRecordItemRoute({ model: "beneficiary" });
```
```ts
// src/app/api/vault/[id]/route.ts
import { createEncryptedRecordItemRoute } from "@/lib/encrypted-record-item-route";
export const { PUT, DELETE } = createEncryptedRecordItemRoute({ model: "vaultItem" });
```

- [ ] **Step 2: Add api-client methods** (in `src/lib/api-client.ts`, inside the `api` object, after `addRecord`)

```ts
  updateRecord: async (resource: string, id: string, ciphertext: string, iv: string) => {
    const res = await fetch(`/api/${resource}/${id}`, {
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
  deleteRecord: async (resource: string, id: string) => {
    const res = await fetch(`/api/${resource}/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `Request failed (${res.status})`);
    }
    return res.json() as Promise<{ ok: true }>;
  },
```

- [ ] **Step 3: Gates**

Run: `npx tsc --noEmit && npm run build`
Expected: clean; build lists the five new dynamic routes (e.g. `ƒ /api/accounts/[id]`).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/accounts/[id]/route.ts src/app/api/bills/[id]/route.ts src/app/api/loans/[id]/route.ts src/app/api/beneficiaries/[id]/route.ts src/app/api/vault/[id]/route.ts src/lib/api-client.ts
git commit -m "feat: add per-record [id] PUT/DELETE routes and api-client update/delete"
```

---

### Task 4: `useEncryptedRecords.remove` + shared `RecordActions` + wire into 5 pages

**Files:**
- Modify: `src/app/providers/useEncryptedRecords.ts`
- Create: `src/components/RecordActions.tsx`
- Modify: `src/app/accounts/page.tsx`, `src/app/bills/page.tsx`, `src/app/loans/page.tsx`, `src/app/beneficiaries/page.tsx`, `src/app/vault/page.tsx`

**Interfaces:**
- Consumes: `api.deleteRecord` (Task 3).
- Produces: `useEncryptedRecords(...)` return gains `remove(id: string): Promise<boolean>`; `RecordActions({ resource, id, onDelete }): JSX.Element`.

- [ ] **Step 1: Add `remove` to `useEncryptedRecords`** (after the `add` callback; add `remove` to the returned object)

```ts
  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      setError("");
      try {
        await api.deleteRecord(resource, id);
        await load();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "We couldn't delete that.");
        return false;
      }
    },
    [resource, load],
  );
```
Change the return to: `return { items, error, loaded, add, remove, masterKey };`

- [ ] **Step 2: Create `RecordActions`**

```tsx
// src/components/RecordActions.tsx
"use client";

import Link from "next/link";
import { useState } from "react";

export function RecordActions({
  resource,
  id,
  onDelete,
}: {
  resource: string;
  id: string;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="row">
      <Link className="linkbtn" href={`/assistant?type=${resource}&id=${id}`}>
        Edit with assistant
      </Link>
      {confirming ? (
        <>
          <button type="button" onClick={onDelete}>
            Confirm delete
          </button>
          <button type="button" className="linkbtn" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button type="button" className="linkbtn" onClick={() => setConfirming(true)}>
          Delete
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire `RecordActions` into each page**

In each of the five pages: (a) destructure `remove` from the hook (e.g. `const { items, error, loaded, add, remove, masterKey } = useEncryptedRecords...`); (b) import `RecordActions`; (c) inside each record's `.item` card, after the existing content, add the actions. The `resource` string matches the hook's `resource`.

For `src/app/accounts/page.tsx` — add `import { RecordActions } from "@/components/RecordActions";`, destructure `remove`, and add inside the `.item` div (after the `{it.value ? (...) : (...)}` block, still inside the `key={it.id}` div):
```tsx
            <RecordActions resource="accounts" id={it.id} onDelete={() => remove(it.id)} />
```
Apply the identical change to `bills/page.tsx` (`resource="bills"`), `loans/page.tsx` (`resource="loans"`), `beneficiaries/page.tsx` (`resource="beneficiaries"`), and `vault/page.tsx` (`resource="vault"`). In `vault/page.tsx` the card currently renders `{it.value ?? "We couldn't unlock this item."}`; add the `RecordActions` line after that text, inside the `key={it.id}` `.item` div.

- [ ] **Step 4: Gates**

Run: `npx tsc --noEmit && npm run build`
Expected: clean; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/app/providers/useEncryptedRecords.ts src/components/RecordActions.tsx src/app/accounts/page.tsx src/app/bills/page.tsx src/app/loans/page.tsx src/app/beneficiaries/page.tsx src/app/vault/page.tsx
git commit -m "feat: add Delete (inline confirm) + Edit-with-assistant actions to record pages"
```

---

### Task 5: Chat route `editContext` → system prompt

**Files:**
- Modify: `src/app/api/assistant/chat/route.ts`
- Modify: `src/app/api/assistant/chat/route.test.ts`

**Interfaces:**
- Consumes: existing route + `buildAssistantSystemPrompt`.
- Produces: the route now reads optional `body.editContext: { type: string; currentFields: Record<string, unknown> }` and, when present, appends an editing-context block to the `system` string passed to `streamText`.

- [ ] **Step 1: Add the failing test** (append a case to `route.test.ts`)

```ts
  it("appends editing context to the system prompt when editContext is present", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    await POST(postReq({
      messages: [],
      editContext: { type: "loan", currentFields: { lender: "Wells Fargo", interestRate: "6.1" } },
    }));
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const arg = streamTextMock.mock.calls[0][0] as { system: string };
    expect(arg.system).toContain("editing an existing loan");
    expect(arg.system).toContain("Wells Fargo");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/assistant/chat/route.test.ts`
Expected: FAIL — system prompt does not contain the editing context.

- [ ] **Step 3: Implement** (in `route.ts`, between reading `messages` and the `streamText` call)

```ts
  const editContext = body.editContext as
    | { type?: string; currentFields?: Record<string, unknown> }
    | undefined;

  let system = buildAssistantSystemPrompt();
  if (editContext?.type && editContext.currentFields) {
    system +=
      `\n\nThe user is editing an existing ${editContext.type} record. ` +
      `Its current values are:\n${JSON.stringify(editContext.currentFields)}\n` +
      `When they describe a change, call proposeRecord with the SAME record type, ` +
      `applying their change and preserving every field they did not mention.`;
  }
```
Then change the `streamText` call to use `system` instead of the inline `buildAssistantSystemPrompt()`:
```ts
  const result = streamText({
    model: anthropic(MODEL_ID),
    system,
    messages: await convertToModelMessages(messages),
    tools: { proposeRecord },
    onError: ({ error }) => {
      console.error("[assistant/chat] streamText error:", error);
    },
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/assistant/chat/route.test.ts`
Expected: PASS (existing 3 + new 1).

- [ ] **Step 5: Gates + commit**

Run: `npm test && npx tsc --noEmit`
```bash
git add src/app/api/assistant/chat/route.ts src/app/api/assistant/chat/route.test.ts
git commit -m "feat: chat route appends pinned-record edit context to the system prompt"
```

---

### Task 6: `useEditTarget` hook + `useAssistant` edit-awareness

**Files:**
- Create: `src/app/providers/useEditTarget.ts`
- Modify: `src/app/providers/useAssistant.ts`

**Interfaces:**
- Consumes: `useKey`, `api.listRecords`, `api.deleteRecord`, `decryptItem`, `parseToFields`, `RECORD_SCHEMA_BY_KEY`, `RecordTypeKey`, `ProposedFields`.
- Produces:
  - `interface EditTarget { type: RecordTypeKey; id: string; label: string; currentFields: ProposedFields }`
  - `function useEditTarget(params: { type: string; id: string } | null): { editTarget: EditTarget | null; loadError: string | null }`
  - `useAssistant(editTarget?: EditTarget | null)` — same return shape as before, edit-aware (see below). Adds `deletePinned(): Promise<boolean>` to the returned object.

**Verify first (AGENTS.md):** confirm `@ai-sdk/react`'s `sendMessage` accepts a per-call options object carrying `body` (e.g. `chat.sendMessage({ text }, { body })`). Check `node_modules/@ai-sdk/react/dist/index.d.ts`. If the per-message `body` is named differently or unsupported, fall back to setting `body` on the `DefaultChatTransport` constructed from `editTarget` (rebuild the transport via `useMemo` keyed on the editTarget id) and note the change.

- [ ] **Step 1: Create `useEditTarget`**

```ts
// src/app/providers/useEditTarget.ts
"use client";

import { useEffect, useState } from "react";
import { useKey } from "@/app/providers/KeyProvider";
import { api } from "@/lib/api-client";
import { decryptItem } from "@/lib/crypto";
import {
  parseToFields,
  RECORD_SCHEMA_BY_KEY,
  type RecordTypeKey,
  type ProposedFields,
} from "@/lib/assistant/record-schemas";

export interface EditTarget {
  type: RecordTypeKey;
  id: string;
  label: string;
  currentFields: ProposedFields;
}

interface EncryptedRow {
  id: string;
  ciphertext: string;
  iv: string;
}

function isRecordType(t: string): t is RecordTypeKey {
  return t in RECORD_SCHEMA_BY_KEY;
}

export function useEditTarget(params: { type: string; id: string } | null): {
  editTarget: EditTarget | null;
  loadError: string | null;
} {
  const { masterKey } = useKey();
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const type = params?.type ?? null;
  const id = params?.id ?? null;

  useEffect(() => {
    if (!type || !id || !masterKey || !isRecordType(type)) {
      setEditTarget(null);
      setLoadError(null);
      return;
    }
    const schema = RECORD_SCHEMA_BY_KEY[type];
    let active = true;
    (async () => {
      setLoadError(null);
      try {
        const data = await api.listRecords(schema.resource);
        const rows = (data[schema.resource] ?? data.items ?? []) as EncryptedRow[];
        const row = rows.find((r) => r.id === id);
        if (!row) {
          if (active) setLoadError("We couldn't find that record to edit.");
          return;
        }
        const plaintext = await decryptItem(masterKey, row.ciphertext, row.iv);
        const currentFields = parseToFields(type, plaintext);
        if (active) setEditTarget({ type, id, label: schema.label, currentFields });
      } catch {
        if (active) setLoadError("We couldn't load that record to edit.");
      }
    })();
    return () => {
      active = false;
    };
  }, [type, id, masterKey]);

  return { editTarget, loadError };
}
```

Note: the list response key is the per-type `listKey`. Accounts/bills/loans/beneficiaries use their resource name as the key; vault uses `items`. The `data[schema.resource] ?? data.items ?? []` fallback covers both (vault's `resource` is `"vault"` but its `listKey` is `"items"`).

- [ ] **Step 2: Make `useAssistant` edit-aware** (modify `src/app/providers/useAssistant.ts`)

Add the import and parameter, thread `editTarget` through `send`, `pendingProposal`, `confirmProposal`, and add `deletePinned`:

```ts
import { type EditTarget } from "@/app/providers/useEditTarget";
// add to existing imports from record-schemas: toPlaintext already imported
```
Change the signature: `export function useAssistant(editTarget: EditTarget | null = null) {`

Replace `send` so edit mode rides the editContext on each message:
```ts
  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setError(null);
      setSavedNotice(null);
      if (editTarget) {
        chat.sendMessage(
          { text: trimmed },
          { body: { editContext: { type: editTarget.type, currentFields: editTarget.currentFields } } },
        );
      } else {
        chat.sendMessage({ text: trimmed });
      }
    },
    [chat, editTarget],
  );
```

Replace `pendingProposal` so edit mode forces the pinned type and pre-fills current values under the model's proposed changes:
```ts
  const pendingProposal = useMemo(() => {
    const raw = findPendingProposal(chat.messages as UIMessage[]);
    if (!raw) return null;
    if (editTarget) {
      return {
        toolCallId: raw.toolCallId,
        type: editTarget.type,
        fields: { ...editTarget.currentFields, ...raw.fields },
      };
    }
    return raw;
  }, [chat.messages, editTarget]);
```

Replace `confirmProposal` so edit mode does PUT:
```ts
  const confirmProposal = useCallback(
    async (type: RecordTypeKey, fields: ProposedFields) => {
      if (!masterKey || !pendingProposal) return;
      setError(null);
      try {
        const plaintext = toPlaintext(type, fields);
        const { ciphertext, iv } = await encryptItem(masterKey, plaintext);
        if (editTarget) {
          await api.updateRecord(RECORD_SCHEMA_BY_KEY[type].resource, editTarget.id, ciphertext, iv);
        } else {
          await api.addRecord(RECORD_SCHEMA_BY_KEY[type].resource, ciphertext, iv);
        }
        await chat.addToolOutput({
          tool: "proposeRecord",
          toolCallId: pendingProposal.toolCallId,
          output: { saved: true, type },
        });
        setSavedNotice(
          editTarget
            ? `Updated your ${RECORD_SCHEMA_BY_KEY[type].label.toLowerCase()}.`
            : `Saved your ${RECORD_SCHEMA_BY_KEY[type].label.toLowerCase()}.`,
        );
      } catch (e) {
        if (e instanceof MissingRequiredFieldError) {
          setError(`Please fill in the ${e.field} field before saving.`);
        } else {
          setError("We couldn't save that. Please try again.");
        }
      }
    },
    [masterKey, pendingProposal, chat, editTarget],
  );
```

Add `deletePinned` (before the return):
```ts
  const deletePinned = useCallback(async (): Promise<boolean> => {
    if (!editTarget) return false;
    setError(null);
    try {
      await api.deleteRecord(RECORD_SCHEMA_BY_KEY[editTarget.type].resource, editTarget.id);
      return true;
    } catch {
      setError("We couldn't delete that record.");
      return false;
    }
  }, [editTarget]);
```

Add `deletePinned` to the returned object.

- [ ] **Step 3: Gates**

Run: `npx tsc --noEmit && npm run build`
Expected: clean. (No unit test for these hooks — node harness; correctness is `tsc` + Task 8 manual.)

- [ ] **Step 4: Commit**

```bash
git add src/app/providers/useEditTarget.ts src/app/providers/useAssistant.ts
git commit -m "feat: useEditTarget loads pinned record; useAssistant edits via PUT with edit context"
```

---

### Task 7: `/assistant` page edit mode

**Files:**
- Modify: `src/app/assistant/page.tsx`

**Interfaces:**
- Consumes: `useEditTarget`, `useAssistant(editTarget)`, `useSearchParams` from `next/navigation`, `useRouter`, the per-type page paths.

**Verify first:** a client page reading `useSearchParams()` must be wrapped in a `<Suspense>` boundary under Next App Router. The existing page is `"use client"`; wrap the search-param-reading body in `<Suspense>` (split into an inner component) to satisfy the build, or confirm the build passes without it.

- [ ] **Step 1: Rewrite `page.tsx` to support both modes**

```tsx
// src/app/assistant/page.tsx
"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { type UIMessage } from "ai";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { useAssistant } from "@/app/providers/useAssistant";
import { useEditTarget } from "@/app/providers/useEditTarget";
import { ProposalCard } from "@/components/assistant/ProposalCard";

function MessageText({ message }: { message: UIMessage }) {
  const text = message.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("");
  if (!text) return null;
  return (
    <div className="item">
      <span className="subtle">{message.role === "user" ? "You" : "Assistant"}</span>
      <div>{text}</div>
    </div>
  );
}

function AssistantInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const type = sp.get("type");
  const id = sp.get("id");
  const params = type && id ? { type, id } : null;

  const { editTarget, loadError } = useEditTarget(params);
  const {
    messages,
    status,
    send,
    pendingProposal,
    confirmProposal,
    discardProposal,
    deletePinned,
    savedNotice,
    error,
    masterKey,
  } = useAssistant(editTarget);
  const [input, setInput] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (!masterKey) return null;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    send(input);
    setInput("");
  }

  async function onDeletePinned() {
    if (!editTarget) return;
    if (await deletePinned()) router.push(`/${editTarget.type === "vault" ? "vault" : editTarget.type + "s"}`);
  }

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Assistant</h1>

        {editTarget ? (
          <>
            <p className="subtle">
              Editing your {editTarget.label.toLowerCase()}. Tell me what to change — I&apos;ll
              update only this record. It stays encrypted on your device.
            </p>
            {confirmingDelete ? (
              <div className="row">
                <button type="button" onClick={onDeletePinned}>
                  Confirm delete
                </button>
                <button type="button" className="linkbtn" onClick={() => setConfirmingDelete(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" className="linkbtn" onClick={() => setConfirmingDelete(true)}>
                Delete this record
              </button>
            )}
          </>
        ) : (
          <p className="subtle">
            Describe a record in your own words and I&apos;ll help you save it. This chat isn&apos;t
            stored — only the records you choose to save are kept, encrypted on your device.
          </p>
        )}

        {loadError && <p className="error">{loadError}</p>}

        {messages.map((m) => (
          <MessageText key={m.id} message={m} />
        ))}

        {pendingProposal && (
          <ProposalCard
            key={pendingProposal.toolCallId}
            type={pendingProposal.type}
            initialFields={pendingProposal.fields}
            onSave={confirmProposal}
            onDiscard={discardProposal}
            error={error}
          />
        )}

        {savedNotice && <p className="subtle">{savedNotice}</p>}
        {error && !pendingProposal && <p className="error">{error}</p>}

        <form className="row" onSubmit={onSubmit}>
          <input
            value={input}
            placeholder={
              editTarget ? "e.g. change the rate to 6%" : "e.g. Add my Wells Fargo mortgage, about 280k left at 6.1%"
            }
            onChange={(e) => setInput(e.target.value)}
            disabled={status === "streaming" || status === "submitted"}
          />
          <button type="submit" disabled={status === "streaming" || status === "submitted"}>
            Send
          </button>
        </form>
      </div>
    </main>
  );
}

export default function AssistantPage() {
  return (
    <Suspense fallback={null}>
      <AssistantInner />
    </Suspense>
  );
}
```

Note on the back-navigation path: resources are pluralized type + "s" (`account`→`accounts`, `bill`→`bills`, `loan`→`loans`, `beneficiary`→`beneficiaries`) except `vault`. `beneficiary` + "s" = `beneficiarys` is WRONG — use the resource from the registry instead. Replace the `router.push` line with the registry resource:
```tsx
    if (await deletePinned()) {
      const { RECORD_SCHEMA_BY_KEY } = await import("@/lib/assistant/record-schemas");
      router.push(`/${RECORD_SCHEMA_BY_KEY[editTarget.type].resource}`);
    }
```
(Or add a static import of `RECORD_SCHEMA_BY_KEY` at the top and use `router.push(\`/${RECORD_SCHEMA_BY_KEY[editTarget.type].resource}\`)` — prefer the static import.)

- [ ] **Step 2: Gates**

Run: `npx tsc --noEmit && npm run build`
Expected: clean; `/assistant` builds (with the `Suspense` boundary for `useSearchParams`).

- [ ] **Step 3: Commit**

```bash
git add src/app/assistant/page.tsx
git commit -m "feat: /assistant edit mode — pinned-record banner, delete, edit conversation"
```

---

### Task 8: Manual verification + final gates

**Files:** none (verification only). Requires `npm run dev`, a working `ANTHROPIC_API_KEY`, and an unlocked vault.

- [ ] **Step 1: Automated gates**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: all pass; build lists the five `/api/<type>/[id]` routes.

- [ ] **Step 2: Delete on a page**

Log in, unlock, open `/accounts` (add one if empty). Each card shows "Edit with assistant" + "Delete". Click **Delete** → it becomes "Confirm delete / Cancel". Cancel leaves it. Delete → Confirm → the card disappears and the list reloads. Repeat the spot-check on `/vault`.

- [ ] **Step 3: Conversational edit**

On a loan/account card click **Edit with assistant** → lands on `/assistant?type=…&id=…` with an "Editing your …" banner and current values implied. Type "change the interest rate to 6%". Expect a streamed reply then a **pre-filled** `ProposalCard` showing the record with the rate changed and other fields intact. Save → "Updated your …". Open the record's page → the change persisted (and it still decrypts). 

- [ ] **Step 4: Delete from the pinned-edit view**

From an edit deep-link, click **Delete this record** → Confirm → it deletes and navigates back to the record's list page (correct resource, incl. beneficiaries/vault).

- [ ] **Step 5: ZK / scope check (DevTools → Network)**

During an edit: confirm the `POST /api/assistant/chat` request body carries `editContext` for exactly the ONE pinned record (no other records), and the Save fires `PUT /api/<type>/<id>` with only `{ ciphertext, iv }`. Delete fires `DELETE /api/<type>/<id>` with no body. Confirm editing/deleting a record id you don't own (or a bogus id) returns 404 (the assistant surfaces "no longer exists").

- [ ] **Step 6: Final commit (only if verification required fixes)**

```bash
git add -A && git commit -m "fix: address Slice B verification findings"
```

---

## Self-Review

**1. Spec coverage:**
- Per-record ownership-scoped PUT/DELETE → Task 2 (factory), Task 3 (routes). ✓
- api-client update/delete → Task 3. ✓
- Delete buttons (inline confirm) on all 5 pages → Task 4 (`RecordActions` + wiring). ✓
- Edit deep-link → Task 4 (`RecordActions` link) + Task 7 (page reads params). ✓
- `parseToFields` inverse → Task 1. ✓
- Pinned-record load/decrypt → Task 6 (`useEditTarget`). ✓
- Edit context to model → Task 5 (chat route) + Task 6 (`send` body). ✓
- Reuse proposeRecord + pre-filled card, PUT branch → Task 6 (`pendingProposal` merge, `confirmProposal` branch). ✓
- Edit-mode page (banner, delete, merged card) → Task 7. ✓
- Conversational delete OUT of scope; delete = button (page + pinned view) → Tasks 4, 7. ✓
- ZK boundary (one record to model; delete sends only id; ciphertext at rest) → Tasks 2, 5, 6 + Task 8 Step 5 verification. ✓
- Error handling (404, load failure, save failure, lost key) → Task 2 (404), Task 6 (`loadError`, catch), Task 7 (surfaces). ✓
- Testing scope (pure lib + routes automated; UI/edit manual) → Tasks 1,2,5 automated; Task 8 manual. ✓

**2. Placeholder scan:** No `TBD`/`TODO`/"add error handling"/"write tests for the above". All code steps carry complete code. The Task 7 back-nav path bug (`beneficiary`+"s") is explicitly called out and resolved by using `RECORD_SCHEMA_BY_KEY[...].resource`.

**3. Type consistency:** `EditTarget { type, id, label, currentFields }` defined in `useEditTarget` (Task 6), consumed by `useAssistant(editTarget)` (Task 6) and the page (Task 7). `parseToFields(type, plaintext): ProposedFields` (Task 1) consumed by `useEditTarget` (Task 6). `updateRecord(resource, id, ciphertext, iv)` / `deleteRecord(resource, id)` (Task 3) consumed by `useEncryptedRecords.remove` (Task 4), `confirmProposal`/`deletePinned` (Task 6). `createEncryptedRecordItemRoute({ model })` (Task 2) consumed by the five routes (Task 3). The proposal `type` in edit mode is forced to `editTarget.type`, matching `confirmProposal`'s use of `RECORD_SCHEMA_BY_KEY[type].resource`. Resource strings (`accounts`/`bills`/`loans`/`beneficiaries`/`vault`) match existing routes throughout.
