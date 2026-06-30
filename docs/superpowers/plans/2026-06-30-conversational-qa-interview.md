# Conversational Q&A + Proactive Interview (Slice C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the default `/assistant` chat so it can answer questions about the user's existing records and run a proactive "find what's missing" interview — without breaking the zero-knowledge invariant.

**Architecture:** Add a second no-`execute` tool, `readRecords(types)`, to the existing chat route; the browser decrypts only the requested categories and returns them via `addToolOutput` (mirrors `proposeRecord`). The proactive interview is driven by a **contents-free readiness digest** computed in the browser and passed in the request body (mirrors `editContext`). Everything else reuses the Slice A/B engine. The transcript stays ephemeral; nothing new is persisted server-side.

**Tech Stack:** Next.js 16 (App Router, TS strict), AI SDK v7 (`ai@7`, `@ai-sdk/react`, `@ai-sdk/anthropic`), browser WebCrypto, Vitest.

## Global Constraints

- **Zero-knowledge invariant:** server stores only `{ ciphertext, iv }`; the master key never leaves the browser; all encrypt/decrypt is client-side via `src/lib/crypto.ts`. Slice C adds **zero** net new server-side plaintext.
- **No new dependencies.** Tool input schemas use the AI SDK `jsonSchema()` helper — **no `zod`**.
- **AI SDK v7 reality:** chat route returns `result.toUIMessageStreamResponse()`; `convertToModelMessages` is **async**; the client uses `addToolOutput` (NOT the deprecated `addToolResult`). Confirm v7 behavior against `node_modules/next/dist/docs/` and the installed SDK before writing route/streaming code.
- **`MODEL_ID`** stays a single module constant in the route (`claude-opus-4-8`).
- **Resource (plural, e.g. `accounts`) vs type-key (singular, e.g. `account`)** must stay distinct — always resolve through `RECORD_SCHEMA_BY_KEY[type].resource`. (This is the bug that bit Slice B.)
- **Reads are auto + transparent:** execute immediately, but every read pushes a visible "🔓 Read your <label>" notice into the UI. Never silent.
- **Vault list quirk:** `api.listRecords("vault")` returns rows under the `items` key, not `vault`. Resolve rows as `data[resource] ?? data.items ?? []`.
- **Gates (run for every task that changes code):** `npm test`, `npx tsc --noEmit`, and `npm run build` before the final commit.
- Tests are `*.test.ts` next to source; brand copy stays calm/warm.

---

### Task 1: `readRecords` tool input schema (registry)

**Files:**
- Modify: `src/lib/assistant/record-schemas.ts` (append exports near `buildProposeRecordJsonSchema`)
- Test: `src/lib/assistant/record-schemas.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `RECORD_SCHEMAS`, `RecordTypeKey`, `JSONSchema7` (already imported in the file).
- Produces:
  - `READ_RECORD_TYPE_KEYS: readonly RecordTypeKey[]`
  - `buildReadRecordsJsonSchema(): JSONSchema7` — object `{ types: string[] }`, `types.items.enum` = the five type keys, `required: ["types"]`.

- [ ] **Step 1: Write the failing test** — append to `src/lib/assistant/record-schemas.test.ts`:

```ts
import {
  READ_RECORD_TYPE_KEYS,
  buildReadRecordsJsonSchema,
} from "@/lib/assistant/record-schemas";

describe("buildReadRecordsJsonSchema", () => {
  it("requires a `types` array whose items enum the five record keys", () => {
    const schema = buildReadRecordsJsonSchema() as {
      required: string[];
      properties: { types: { type: string; items: { enum: string[] } } };
    };
    expect(schema.required).toContain("types");
    expect(schema.properties.types.type).toBe("array");
    expect(schema.properties.types.items.enum.sort()).toEqual(
      ["account", "beneficiary", "bill", "loan", "vault"].sort(),
    );
  });

  it("READ_RECORD_TYPE_KEYS lists every record type key", () => {
    expect([...READ_RECORD_TYPE_KEYS].sort()).toEqual(
      ["account", "beneficiary", "bill", "loan", "vault"].sort(),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/assistant/record-schemas.test.ts`
Expected: FAIL — `buildReadRecordsJsonSchema`/`READ_RECORD_TYPE_KEYS` not exported.

- [ ] **Step 3: Write minimal implementation** — append to `src/lib/assistant/record-schemas.ts` (after `buildProposeRecordJsonSchema`):

```ts
export const READ_RECORD_TYPE_KEYS: readonly RecordTypeKey[] = RECORD_SCHEMAS.map(
  (s) => s.key,
);

export function buildReadRecordsJsonSchema(): JSONSchema7 {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      types: {
        type: "array",
        description:
          "The record categories to read in order to answer the user's question. Include ONLY the categories the question needs.",
        items: { type: "string", enum: [...READ_RECORD_TYPE_KEYS] },
      },
    },
    required: ["types"],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/assistant/record-schemas.test.ts`
Expected: PASS (all blocks, including the existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/lib/assistant/record-schemas.ts src/lib/assistant/record-schemas.test.ts
git commit -m "feat(assistant): readRecords tool input schema in registry"
```

---

### Task 2: Pure digest + record-serialization helpers

**Files:**
- Create: `src/lib/assistant/records-digest.ts`
- Test: `src/lib/assistant/records-digest.test.ts`

**Interfaces:**
- Consumes: `ReadinessReport` from `@/lib/readiness`; `RECORD_SCHEMA_BY_KEY`, `RecordTypeKey`, `ProposedFields` from `@/lib/assistant/record-schemas`.
- Produces:
  - `interface DigestCategory { key: string; label: string; status: "complete" | "attention" | "empty"; suggestion?: string }`
  - `interface ReadinessDigest { overall: number; categories: DigestCategory[] }`
  - `buildReadinessDigest(report: ReadinessReport): ReadinessDigest`
  - `interface ModelRecords { type: RecordTypeKey; label: string; count: number; records: ProposedFields[] }`
  - `serializeRecordsForModel(type: RecordTypeKey, records: ProposedFields[]): ModelRecords`

- [ ] **Step 1: Write the failing test** — create `src/lib/assistant/records-digest.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  buildReadinessDigest,
  serializeRecordsForModel,
} from "@/lib/assistant/records-digest";
import { computeReadiness } from "@/lib/readiness";

describe("buildReadinessDigest", () => {
  const report = computeReadiness({
    accounts: [
      { type: "Checking", institution: "Chase", nickname: "", accountNumber: "", balance: "100", notes: "" },
    ],
    bills: [],
    loans: [],
    beneficiaries: [],
    vaultCount: 0,
    obituaryDraftPresent: false,
    acknowledgedEmpty: [],
  });

  it("projects the report to overall + contents-free categories", () => {
    const digest = buildReadinessDigest(report);
    expect(digest.overall).toBe(report.overall);
    const accounts = digest.categories.find((c) => c.key === "accounts")!;
    expect(accounts.status).toBe("complete");
    const loans = digest.categories.find((c) => c.key === "loans")!;
    expect(loans.status).toBe("empty");
    expect(loans.suggestion).toBeTruthy();
  });

  it("carries no record contents (only key/label/status/suggestion fields)", () => {
    const digest = buildReadinessDigest(report);
    for (const c of digest.categories) {
      expect(Object.keys(c).sort()).toEqual(
        c.suggestion
          ? ["key", "label", "status", "suggestion"].sort()
          : ["key", "label", "status"].sort(),
      );
    }
  });
});

describe("serializeRecordsForModel", () => {
  it("packages records with their type label and count", () => {
    const out = serializeRecordsForModel("loan", [
      { lender: "Wells Fargo", currentBalance: "280000" },
    ]);
    expect(out).toEqual({
      type: "loan",
      label: "Loan or mortgage",
      count: 1,
      records: [{ lender: "Wells Fargo", currentBalance: "280000" }],
    });
  });

  it("reports count 0 for an empty category", () => {
    expect(serializeRecordsForModel("bill", []).count).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/assistant/records-digest.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation** — create `src/lib/assistant/records-digest.ts`:

```ts
import { type ReadinessReport } from "@/lib/readiness";
import {
  RECORD_SCHEMA_BY_KEY,
  type RecordTypeKey,
  type ProposedFields,
} from "@/lib/assistant/record-schemas";

export interface DigestCategory {
  key: string;
  label: string;
  status: "complete" | "attention" | "empty";
  suggestion?: string;
}

export interface ReadinessDigest {
  overall: number;
  categories: DigestCategory[];
}

// Project the readiness report to a compact, CONTENTS-FREE summary for the model.
export function buildReadinessDigest(report: ReadinessReport): ReadinessDigest {
  return {
    overall: report.overall,
    categories: report.categories.map((c) => {
      const out: DigestCategory = { key: c.key, label: c.label, status: c.status };
      if (c.suggestion) out.suggestion = c.suggestion;
      return out;
    }),
  };
}

export interface ModelRecords {
  type: RecordTypeKey;
  label: string;
  count: number;
  records: ProposedFields[];
}

// Package already-decrypted records of one type into a model-readable shape.
export function serializeRecordsForModel(
  type: RecordTypeKey,
  records: ProposedFields[],
): ModelRecords {
  return {
    type,
    label: RECORD_SCHEMA_BY_KEY[type].label,
    count: records.length,
    records,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/assistant/records-digest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/assistant/records-digest.ts src/lib/assistant/records-digest.test.ts
git commit -m "feat(assistant): pure readiness-digest + record-serialization helpers"
```

---

### Task 3: `findPendingRead` stream helper

**Files:**
- Create: `src/app/providers/find-pending-read.ts`
- Test: `src/app/providers/find-pending-read.test.ts`

**Interfaces:**
- Consumes: `isToolUIPart`, `getToolName`, `UIMessage` from `ai`; `RECORD_SCHEMA_BY_KEY`, `RecordTypeKey` from the registry.
- Produces:
  - `interface PendingRead { toolCallId: string; types: RecordTypeKey[] }`
  - `findPendingRead(messages: UIMessage[]): PendingRead | null` — most-recent unresolved `readRecords` call; `types` filtered to known keys (unknowns dropped; may be `[]`).

- [ ] **Step 1: Write the failing test** — create `src/app/providers/find-pending-read.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { findPendingRead } from "./find-pending-read";
import type { UIMessage } from "ai";

function makeMsg(parts: unknown[]): UIMessage {
  return { id: "m", role: "assistant", parts } as unknown as UIMessage;
}
function readPart(state: string, input: Record<string, unknown>, toolCallId: string) {
  return { type: "tool-readRecords", state, input, toolCallId };
}

describe("findPendingRead", () => {
  it("returns null for an empty array", () => {
    expect(findPendingRead([])).toBeNull();
  });

  it("surfaces an input-available readRecords call with known types", () => {
    const messages = [makeMsg([readPart("input-available", { types: ["loan", "bill"] }, "r1")])];
    expect(findPendingRead(messages)).toEqual({ toolCallId: "r1", types: ["loan", "bill"] });
  });

  it("drops unknown type keys but still returns the call", () => {
    const messages = [makeMsg([readPart("input-available", { types: ["loan", "bogus"] }, "r1")])];
    expect(findPendingRead(messages)).toEqual({ toolCallId: "r1", types: ["loan"] });
  });

  it("ignores a readRecords call that already has output", () => {
    const messages = [
      makeMsg([{ ...readPart("output-available", { types: ["loan"] }, "r1"), output: { records: [] } }]),
    ];
    expect(findPendingRead(messages)).toBeNull();
  });

  it("ignores proposeRecord parts", () => {
    const messages = [
      makeMsg([{ type: "tool-proposeRecord", state: "input-available", input: { type: "vault" }, toolCallId: "p1" }]),
    ];
    expect(findPendingRead(messages)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/providers/find-pending-read.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation** — create `src/app/providers/find-pending-read.ts`:

```ts
import { isToolUIPart, getToolName, type UIMessage } from "ai";
import { RECORD_SCHEMA_BY_KEY, type RecordTypeKey } from "@/lib/assistant/record-schemas";

export interface PendingRead {
  toolCallId: string;
  types: RecordTypeKey[];
}

export function findPendingRead(messages: UIMessage[]): PendingRead | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const part of messages[i].parts) {
      if (
        isToolUIPart(part) &&
        getToolName(part) === "readRecords" &&
        part.state === "input-available"
      ) {
        const raw = (part as { input: unknown }).input;
        const input = (raw ?? {}) as { types?: unknown };
        const types = Array.isArray(input.types)
          ? input.types.filter(
              (t): t is RecordTypeKey =>
                typeof t === "string" && t in RECORD_SCHEMA_BY_KEY,
            )
          : [];
        return { toolCallId: part.toolCallId, types };
      }
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/providers/find-pending-read.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/providers/find-pending-read.ts src/app/providers/find-pending-read.test.ts
git commit -m "feat(assistant): findPendingRead stream helper"
```

---

### Task 4: Extend the system prompt (read + interview behavior)

**Files:**
- Modify: `src/lib/assistant/prompt.ts`
- Test: `src/lib/assistant/prompt.test.ts` (replace the "never see" assertion)

**Interfaces:**
- Consumes: `RECORD_SCHEMAS` (already imported).
- Produces: `buildAssistantSystemPrompt()` (same signature) now describing `readRecords` and digest-driven interview behavior.

**Note:** The current prompt asserts "You never see the user's existing saved records." Slice C makes that **false** — the model can now read records on request. Update both the prompt line and the test that pins it.

- [ ] **Step 1: Update the test first (red)** — in `src/lib/assistant/prompt.test.ts`, replace the third `it(...)` block with:

```ts
  it("states records are encrypted and must be read via readRecords, not guessed", () => {
    expect(prompt).toContain("institution"); // still lists a required field
    expect(prompt).toContain("readRecords");
    const lower = prompt.toLowerCase();
    expect(lower).toContain("encrypted");
    expect(lower).toContain("only the categories");
    expect(lower).toContain("never guess");
  });

  it("describes the proactive readiness-summary interview", () => {
    const lower = prompt.toLowerCase();
    expect(lower).toContain("readiness summary");
    expect(lower).toContain("what to add next");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/assistant/prompt.test.ts`
Expected: FAIL — prompt lacks `readRecords` / "readiness summary" wording.

- [ ] **Step 3: Update the prompt** — in `src/lib/assistant/prompt.ts`, replace the single bullet

```ts
    "- You never see the user's existing saved records — they are encrypted. Work only from what the user tells you in this conversation.",
```

with these bullets:

```ts
    "- The user's saved records are encrypted and you cannot see them unless you ask. To answer a question about existing records, call the `readRecords` tool with ONLY the categories the question needs (for example, loans for a debt question). Never guess record contents — read them.",
    "- If a category has no records, say so plainly. Never invent records the user has not saved.",
    "- When a readiness summary of what the user has and is missing is provided, you may proactively and warmly suggest what to add next, and offer to capture it with proposeRecord. Base suggestions only on that summary — do not invent gaps.",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/assistant/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/assistant/prompt.ts src/lib/assistant/prompt.test.ts
git commit -m "feat(assistant): prompt teaches readRecords + interview, drops 'never see' claim"
```

---

### Task 5: Wire `readRecords` tool + `readinessDigest` body into the chat route

**Files:**
- Modify: `src/app/api/assistant/chat/route.ts`
- Test: `src/app/api/assistant/chat/route.test.ts` (add two cases)

**Interfaces:**
- Consumes: `buildReadRecordsJsonSchema` (Task 1); existing `streamText`, `tool`, `jsonSchema`, `requireUserId`, `readJsonBody`, `buildAssistantSystemPrompt`, `buildProposeRecordJsonSchema`.
- Produces: the route now passes `tools: { proposeRecord, readRecords }` and, when `body.readinessDigest` is present, appends a "Readiness summary" instruction to `system`.

- [ ] **Step 1: Write the failing tests** — add inside the `describe("POST /api/assistant/chat", ...)` block:

```ts
  it("wires the readRecords tool alongside proposeRecord", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    await POST(postReq({ messages: [] }));
    const arg = streamTextMock.mock.calls[0][0] as {
      tools: { proposeRecord?: unknown; readRecords?: unknown };
    };
    expect(arg.tools.proposeRecord).toBeDefined();
    expect(arg.tools.readRecords).toBeDefined();
  });

  it("appends the readiness summary to the system prompt when readinessDigest is present", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    await POST(postReq({
      messages: [],
      readinessDigest: { overall: 25, categories: [{ key: "loans", label: "Loans", status: "empty" }] },
    }));
    const arg = streamTextMock.mock.calls[0][0] as { system: string };
    expect(arg.system).toContain("Readiness summary");
    expect(arg.system).toContain("Loans");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/assistant/chat/route.test.ts`
Expected: FAIL — `readRecords` undefined; no "Readiness summary" in system.

- [ ] **Step 3: Implement** — edit `src/app/api/assistant/chat/route.ts`:

a) Update the import from the registry:

```ts
import {
  buildProposeRecordJsonSchema,
  buildReadRecordsJsonSchema,
} from "@/lib/assistant/record-schemas";
```

b) Add the tool next to `proposeRecord`:

```ts
// No `execute`: the browser decrypts only the requested categories and returns
// them via addToolOutput. The server never sees record plaintext or persists it.
const readRecords = tool({
  description:
    "Read the user's saved records of the given categories so you can answer their question. The browser decrypts ONLY the requested categories and returns them. Request only the categories you need.",
  inputSchema: jsonSchema(buildReadRecordsJsonSchema()),
});
```

c) After the existing `editContext` block, add:

```ts
  const readinessDigest = body.readinessDigest;
  if (readinessDigest) {
    system +=
      `\n\nReadiness summary of what the user has and is missing ` +
      `(no record contents): ${JSON.stringify(readinessDigest)}\n` +
      `Use it to proactively suggest what to add next when it would help.`;
  }
```

d) Add `readRecords` to the `tools` map:

```ts
    tools: { proposeRecord, readRecords },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/assistant/chat/route.test.ts`
Expected: PASS (existing 4 cases + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/assistant/chat/route.ts src/app/api/assistant/chat/route.test.ts
git commit -m "feat(assistant): route serves readRecords tool + readiness-digest context"
```

---

### Task 6: Browser read-loader for the digest

**Files:**
- Create: `src/app/providers/load-readiness-digest.ts`

**Interfaces:**
- Consumes: `api`, `decryptItem`, the four `parse*` domain fns, `computeReadiness`, `parseReadinessState`, `buildReadinessDigest`, `CryptoBytes`.
- Produces: `async function loadReadinessDigest(masterKey: CryptoBytes): Promise<ReadinessDigest>` — loads + decrypts every category in the browser, computes readiness (honoring the saved "nothing to add" acks), and returns the contents-free digest.

This is browser IO (no unit test — same policy as `useReadinessData`/`useEditTarget`). It mirrors `useReadinessData`'s loader exactly so behavior matches the `/readiness` page.

- [ ] **Step 1: Create the loader** — `src/app/providers/load-readiness-digest.ts`:

```ts
"use client";

import { api } from "@/lib/api-client";
import { decryptItem, type CryptoBytes } from "@/lib/crypto";
import { parseAccount, type Account } from "@/lib/account";
import { parseBill, type Bill } from "@/lib/bill";
import { parseLoan, type Loan } from "@/lib/loan";
import { parseBeneficiary, type Beneficiary } from "@/lib/beneficiary";
import {
  computeReadiness,
  parseReadinessState,
  type ReadinessCategoryKey,
} from "@/lib/readiness";
import { buildReadinessDigest, type ReadinessDigest } from "@/lib/assistant/records-digest";

interface EncryptedRow {
  id: string;
  ciphertext: string;
  iv: string;
}

function rowsOf(data: Record<string, unknown>, key: string): EncryptedRow[] {
  return (data[key] ?? data.items ?? []) as EncryptedRow[];
}

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

export async function loadReadinessDigest(masterKey: CryptoBytes): Promise<ReadinessDigest> {
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

  const [accounts, bills, loans, beneficiaries] = await Promise.all([
    decryptList<Account>(masterKey, rowsOf(acctRes, "accounts"), parseAccount),
    decryptList<Bill>(masterKey, rowsOf(billRes, "bills"), parseBill),
    decryptList<Loan>(masterKey, rowsOf(loanRes, "loans"), parseLoan),
    decryptList<Beneficiary>(masterKey, rowsOf(beneRes, "beneficiaries"), parseBeneficiary),
  ]);

  let acknowledgedEmpty: ReadinessCategoryKey[] = [];
  if (stateRes.state) {
    try {
      acknowledgedEmpty = parseReadinessState(
        await decryptItem(masterKey, stateRes.state.ciphertext, stateRes.state.iv),
      ).acknowledgedEmpty;
    } catch {
      acknowledgedEmpty = [];
    }
  }

  const report = computeReadiness({
    accounts,
    bills,
    loans,
    beneficiaries,
    vaultCount: rowsOf(vaultRes, "vault").length,
    obituaryDraftPresent: Boolean(obit?.obituary?.draft?.trim()),
    acknowledgedEmpty,
  });
  return buildReadinessDigest(report);
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/app/providers/load-readiness-digest.ts
git commit -m "feat(assistant): browser loader for the contents-free readiness digest"
```

---

### Task 7: Read-execution + interview seed in `useAssistant`

**Files:**
- Modify: `src/app/providers/useAssistant.ts`

**Interfaces:**
- Consumes: `findPendingRead`/`PendingRead` (Task 3), `serializeRecordsForModel`/`ReadinessDigest` (Task 2), `loadReadinessDigest` (Task 6), existing `parseToFields`, `decryptItem`, `api`, `RECORD_SCHEMA_BY_KEY`.
- Produces: `useAssistant(...)` return object **gains** `readNotices: string[]` and `startInterview: () => void`. `send` is now async and (in default mode) attaches the cached `readinessDigest` in the request body.

The hook has no node-only unit test (same policy as Slice A/B); it leans on the tested pure helpers. Verify via `tsc`/`build` and the manual smoke (Task 9).

- [ ] **Step 1: Add imports** — extend the imports in `src/app/providers/useAssistant.ts`:

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
```

and add:

```ts
import { decryptItem } from "@/lib/crypto";
import {
  toPlaintext,
  parseToFields,
  RECORD_SCHEMA_BY_KEY,
  MissingRequiredFieldError,
  type RecordTypeKey,
  type ProposedFields,
} from "@/lib/assistant/record-schemas";
import { findPendingRead } from "@/app/providers/find-pending-read";
import {
  serializeRecordsForModel,
  type ReadinessDigest,
} from "@/lib/assistant/records-digest";
import { loadReadinessDigest } from "@/app/providers/load-readiness-digest";
```

(Note: `toPlaintext`, `RECORD_SCHEMA_BY_KEY`, `MissingRequiredFieldError`, `RecordTypeKey`, `ProposedFields` are already imported — merge, don't duplicate. Add only `parseToFields`.)

- [ ] **Step 2: Add module-level constants + row type** — near the top of the file (after imports):

```ts
const INTERVIEW_SEED =
  "Help me figure out what's missing from my Legacy and what I should add next.";

interface EncryptedRow {
  id: string;
  ciphertext: string;
  iv: string;
}

// Decrypt every row of one category into editable fields, skipping bad rows.
async function loadCategoryFields(
  masterKey: import("@/lib/crypto").CryptoBytes,
  type: RecordTypeKey,
): Promise<ProposedFields[]> {
  const schema = RECORD_SCHEMA_BY_KEY[type];
  const data = await api.listRecords(schema.resource);
  const rows = (data[schema.resource] ?? data.items ?? []) as EncryptedRow[];
  const out: ProposedFields[] = [];
  for (const r of rows) {
    try {
      out.push(parseToFields(type, await decryptItem(masterKey, r.ciphertext, r.iv)));
    } catch {
      // undecryptable row — skip it
    }
  }
  return out;
}
```

- [ ] **Step 3: Add hook state + refs** — inside `useAssistant`, after the existing `error` state:

```ts
  const [readNotices, setReadNotices] = useState<string[]>([]);
  const handledReads = useRef<Set<string>>(new Set());
  const digestRef = useRef<ReadinessDigest | null>(null);
```

- [ ] **Step 4: Add the digest cache + read-execution effect** — after the existing `pendingProposal` memo, add:

```ts
  const ensureDigest = useCallback(async (): Promise<ReadinessDigest | undefined> => {
    if (!masterKey) return undefined;
    if (digestRef.current) return digestRef.current;
    try {
      digestRef.current = await loadReadinessDigest(masterKey);
      return digestRef.current;
    } catch {
      return undefined; // never block chat on a digest failure
    }
  }, [masterKey]);

  const pendingRead = useMemo(
    () => findPendingRead(chat.messages as UIMessage[]),
    [chat.messages],
  );

  useEffect(() => {
    if (!pendingRead || !masterKey) return;
    if (handledReads.current.has(pendingRead.toolCallId)) return;
    handledReads.current.add(pendingRead.toolCallId);
    (async () => {
      try {
        const results = [];
        for (const type of pendingRead.types) {
          const fields = await loadCategoryFields(masterKey, type);
          results.push(serializeRecordsForModel(type, fields));
          setReadNotices((prev) => [
            ...prev,
            `🔓 Read your ${RECORD_SCHEMA_BY_KEY[type].label.toLowerCase()} to answer this.`,
          ]);
        }
        await chat.addToolOutput({
          tool: "readRecords",
          toolCallId: pendingRead.toolCallId,
          output: { records: results },
        });
      } catch {
        await chat.addToolOutput({
          tool: "readRecords",
          toolCallId: pendingRead.toolCallId,
          output: { error: "Could not read those records." },
        });
      }
    })();
  }, [pendingRead, masterKey, chat]);
```

- [ ] **Step 5: Make `send` attach the digest in default mode** — replace the existing `send` callback body's `else` branch so default-mode turns carry the digest:

```ts
  const send = useCallback(
    async (text: string) => {
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
        const readinessDigest = await ensureDigest();
        chat.sendMessage({ text: trimmed }, { body: { readinessDigest } });
      }
    },
    [chat, editTarget, ensureDigest],
  );
```

- [ ] **Step 6: Add `startInterview` + invalidate the digest on save** — add after `send`:

```ts
  const startInterview = useCallback(() => {
    void send(INTERVIEW_SEED);
  }, [send]);
```

and in `confirmProposal`, on the **success path** (right after `setSavedNotice(...)`), invalidate the cached digest so the next turn reflects the new record:

```ts
        digestRef.current = null;
```

- [ ] **Step 7: Export the new values** — extend the returned object:

```ts
  return {
    messages: chat.messages as UIMessage[],
    status: chat.status,
    send,
    startInterview,
    readNotices,
    pendingProposal,
    confirmProposal,
    discardProposal,
    deletePinned,
    savedNotice,
    error,
    masterKey,
  };
```

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS. (If `send` being async trips a caller, the page is updated in Task 8.)

- [ ] **Step 9: Run the unit suite** (ensures nothing regressed)

Run: `npm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/app/providers/useAssistant.ts
git commit -m "feat(assistant): client read-execution + lazy digest + startInterview"
```

---

### Task 8: Page — interview button + read notices

**Files:**
- Modify: `src/app/assistant/page.tsx`

**Interfaces:**
- Consumes: `useAssistant` now returns `startInterview` and `readNotices`.
- Produces: a "Help me find what's missing" button (default mode only) and a transparent read-notice log in the transcript.

- [ ] **Step 1: Destructure the new values** — update the `useAssistant` destructure in `AssistantInner`:

```ts
  const {
    messages,
    status,
    send,
    startInterview,
    readNotices,
    pendingProposal,
    confirmProposal,
    discardProposal,
    deletePinned,
    savedNotice,
    error,
    masterKey,
  } = useAssistant(editTarget);
```

- [ ] **Step 2: Add the interview button in default mode** — in the `else` branch of the `editTarget ? ... : (...)` intro (right after the existing default-mode `<p className="subtle">…</p>`), add:

```tsx
            <button
              type="button"
              className="linkbtn"
              onClick={startInterview}
              disabled={status === "streaming" || status === "submitted"}
            >
              Help me find what&apos;s missing
            </button>
```

- [ ] **Step 3: Render the read notices** — immediately after the `messages.map(...)` block, add:

```tsx
        {readNotices.map((n, i) => (
          <p key={i} className="subtle">
            {n}
          </p>
        ))}
```

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/assistant/page.tsx
git commit -m "feat(assistant): interview button + transparent read notices on /assistant"
```

---

### Task 9: Final gates + manual smoke checklist

**Files:**
- Modify: `docs/superpowers/manual-verification-pending.md` (append a Slice C checklist)

- [ ] **Step 1: Run all automated gates**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: all PASS. (Unit suite includes the new registry, digest, and find-pending-read tests; route test includes the two new cases.)

- [ ] **Step 2: Append the manual smoke checklist** to `docs/superpowers/manual-verification-pending.md`:

```markdown
## Slice C — Q&A + proactive interview (pending live smoke)

Requires: `npm run dev`, dev DB, a logged-in user with the vault unlocked, real API tokens.

- [ ] Open `/assistant` (no query params). Ask "what's my total debt?" → a
      "🔓 Read your loan or mortgage…" notice appears and the answer reflects
      only your loans (not other categories).
- [ ] Ask about a category with no records → assistant says you have none, does
      not invent any.
- [ ] Click "Help me find what's missing" → the assistant names real gaps from
      your readiness (matches the `/readiness` page) and offers to add one.
- [ ] Accept a suggestion → ProposalCard → Save → record appears on its own page.
- [ ] DevTools Network: the chat route response is a stream; on Save only
      `{ ciphertext, iv }` leaves; no record plaintext is persisted by
      `/api/assistant/chat` (it returns a stream, stores nothing).
- [ ] Edit mode still works: open `/assistant?type=loans&id=<id>` → pinned banner,
      no interview button, Save fires PUT.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/manual-verification-pending.md
git commit -m "docs: Slice C manual smoke checklist"
```

---

## Self-Review

**Spec coverage:**
- Unified default `/assistant`, edit mode untouched → Tasks 7–8 (button gated to default mode; edit path unchanged). ✓
- `readRecords` no-execute tool, scoped decrypt, in-flight only, nothing persisted → Tasks 1, 5, 7. ✓
- Auto + transparent reads (visible notice) → Task 7 (`readNotices`) + Task 8 (render). ✓
- Contents-free readiness digest, lazy + cached, rides every default-mode turn, invalidated on save → Tasks 2, 6, 7. ✓
- Interview button + typeable, both ZK-clean via the same digest → Task 7 (`startInterview` calls `send`, which attaches the digest) + Task 8. ✓
- Prompt teaches readRecords + interview; drops the false "never see" claim → Task 4. ✓
- Error handling (read failure → error tool output; empty category → count 0; AI/save/key handled by existing code) → Tasks 7 (read error/empty), existing engine. ✓
- Testing: pure helpers unit-tested (Tasks 1–3), prompt test (4), mock-model route test persists-nothing/digest (5), hook path manual (9). ✓
- Vault-gated, resource-vs-key distinction, no new deps, no zod → Global Constraints + resolved via `RECORD_SCHEMA_BY_KEY[type].resource` throughout. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `ReadinessDigest`/`ModelRecords` (Task 2) consumed verbatim in Tasks 5–7; `PendingRead.types: RecordTypeKey[]` (Task 3) consumed in Task 7; `loadReadinessDigest(masterKey)` (Task 6) consumed in Task 7; `startInterview`/`readNotices` produced in Task 7, consumed in Task 8. ✓
