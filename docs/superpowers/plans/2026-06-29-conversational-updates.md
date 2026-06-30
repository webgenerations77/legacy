# Conversational Updates — Conversational Capture Engine (Slice A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a vault-gated `/assistant` chat that turns natural-language descriptions into proposed records the user reviews in an editable card and saves client-encrypted through the existing append-only routes.

**Architecture:** A thin `streamText` chat route exposes a `proposeRecord` tool with **no server `execute`**; the model converses (streamed prose) and emits a tool call when it has enough for one record. The client (`useChat`) surfaces that tool call, renders an editable `ProposalCard`, and on Save runs `encryptItem` + the existing `addRecord` POST, then returns a tool result so the chat continues. A single field-schema registry is the one source of truth for the tool's input schema, the card's rendering, and the map back to each type's existing `serialize`.

**Tech Stack:** Next.js 16 (App Router, TS strict), AI SDK `ai@7.0.5` + `@ai-sdk/anthropic@4` (already installed) + `@ai-sdk/react` (new), WebCrypto via `src/lib/crypto.ts`, Vitest (node env).

## Global Constraints

- **Zero-knowledge invariant:** the server stores only `{ ciphertext, iv }`; the master key never leaves the browser. The model sees only what the user types in chat — never existing vault ciphertext or decrypted records. The chat route persists nothing. Net new server-side plaintext: zero.
- **Vault-gated page:** `/assistant` requires `masterKey` (needed to encrypt on Save); redirect to `/unlock` when absent. The chat *route* requires only an authenticated session (`requireUserId`).
- **No new `zod` dependency:** build the tool input schema with the AI SDK `jsonSchema()` helper over plain JSON Schema.
- **Reuse, don't duplicate:** records save through the existing per-type `serialize` and the existing `api.addRecord(resource, ciphertext, iv)` — assistant-saved records must be byte-identical to form-saved ones.
- **`MODEL_ID`** is a single module constant, default `"claude-opus-4-8"` (mirrors `src/app/api/obituary/generate/route.ts`).
- **Test harness reality:** Vitest runs in `environment: "node"` with **no** React Testing Library / jsdom. Automated tests cover pure libs (`record-schemas`, `prompt`) and the node-side route only. The hook, card, page, and the live streaming/tool-call flow are verified **manually** (`npm run dev`), consistent with how the obituary UI was handled. This is a deliberate, stated scope — not an omitted test.
- **Per `AGENTS.md`:** this Next.js (16.2.9) and AI SDK v7 differ from older training data — read the relevant guide under `node_modules/next/dist/docs/` before route/streaming code, and confirm the AI SDK v7 symbols named in Tasks 3–4 against the installed `.d.ts` files before relying on them.
- **Gates (every task):** `npm test`, `npx tsc --noEmit`, `npm run build`.

## File Structure

- `src/lib/assistant/record-schemas.ts` (create) — the field-schema registry, `toPlaintext`, and `buildProposeRecordJsonSchema`. Pure.
- `src/lib/assistant/record-schemas.test.ts` (create) — unit tests.
- `src/lib/assistant/prompt.ts` (create) — `buildAssistantSystemPrompt`. Pure.
- `src/lib/assistant/prompt.test.ts` (create) — unit tests.
- `src/app/api/assistant/chat/route.ts` (create) — the chat route + `proposeRecord` tool.
- `src/app/api/assistant/chat/route.test.ts` (create) — route auth/wiring tests.
- `src/app/providers/useAssistant.ts` (create) — orchestration hook over `useChat`.
- `src/components/assistant/ProposalCard.tsx` (create) — editable proposal form.
- `src/app/assistant/page.tsx` (create) — the page.
- `src/components/AppNav.tsx` (modify) — add the "Assistant" link.

---

### Task 1: Field-schema registry + `toPlaintext`

**Files:**
- Create: `src/lib/assistant/record-schemas.ts`
- Test: `src/lib/assistant/record-schemas.test.ts`

**Interfaces:**
- Consumes: `serializeAccount`/`Account`/`AccountType` from `@/lib/account`; `serializeBill`/`Bill`/`BillCategory`/`Frequency` from `@/lib/bill`; `serializeLoan`/`Loan`/`LoanKind` from `@/lib/loan`; `serializeBeneficiary`/`Beneficiary`/`BeneficiaryRelationship` from `@/lib/beneficiary`; `JSONSchema7` from `ai`.
- Produces:
  - `type RecordTypeKey = "account" | "bill" | "loan" | "beneficiary" | "vault"`
  - `type ProposedFields = Record<string, string | boolean | undefined>`
  - `interface FieldSchema { key: string; label: string; required: boolean; kind: "text" | "longtext" | "number" | "date" | "boolean"; options?: readonly string[] }`
  - `interface RecordTypeSchema { key: RecordTypeKey; label: string; resource: string; fields: readonly FieldSchema[] }`
  - `const RECORD_SCHEMAS: readonly RecordTypeSchema[]`
  - `const RECORD_SCHEMA_BY_KEY: Record<RecordTypeKey, RecordTypeSchema>`
  - `class MissingRequiredFieldError extends Error { readonly field: string }`
  - `function toPlaintext(type: RecordTypeKey, fields: ProposedFields): string`
  - `function buildProposeRecordJsonSchema(): JSONSchema7`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/assistant/record-schemas.test.ts
import { describe, it, expect } from "vitest";
import {
  RECORD_SCHEMAS,
  RECORD_SCHEMA_BY_KEY,
  toPlaintext,
  buildProposeRecordJsonSchema,
  MissingRequiredFieldError,
} from "@/lib/assistant/record-schemas";
import { parseAccount } from "@/lib/account";
import { parseBill } from "@/lib/bill";
import { parseLoan } from "@/lib/loan";
import { parseBeneficiary } from "@/lib/beneficiary";

describe("record-schemas", () => {
  it("exposes all five record types with a resource and at least one required field", () => {
    expect(RECORD_SCHEMAS.map((s) => s.key).sort()).toEqual(
      ["account", "beneficiary", "bill", "loan", "vault"].sort(),
    );
    expect(RECORD_SCHEMA_BY_KEY.account.resource).toBe("accounts");
    expect(RECORD_SCHEMA_BY_KEY.bill.resource).toBe("bills");
    expect(RECORD_SCHEMA_BY_KEY.loan.resource).toBe("loans");
    expect(RECORD_SCHEMA_BY_KEY.beneficiary.resource).toBe("beneficiaries");
    expect(RECORD_SCHEMA_BY_KEY.vault.resource).toBe("vault");
    for (const s of RECORD_SCHEMAS) {
      expect(s.fields.some((f) => f.required)).toBe(true);
    }
  });

  it("toPlaintext('account') round-trips through serializeAccount with defaults", () => {
    const json = toPlaintext("account", { institution: "Chase", type: "Checking", balance: "100" });
    expect(parseAccount(json)).toEqual({
      type: "Checking",
      institution: "Chase",
      nickname: "",
      accountNumber: "",
      balance: "100",
      notes: "",
    });
  });

  it("toPlaintext('account') falls back to 'Other' for an unknown type value", () => {
    const json = toPlaintext("account", { institution: "Chase", type: "Nonsense" });
    expect(parseAccount(json).type).toBe("Other");
  });

  it("toPlaintext('bill') carries a boolean autoPay and defaults frequency to Monthly", () => {
    const bill = parseBill(toPlaintext("bill", { name: "Netflix", autoPay: true }));
    expect(bill.autoPay).toBe(true);
    expect(bill.frequency).toBe("Monthly");
    expect(bill.category).toBe("Other");
  });

  it("toPlaintext('loan') and ('beneficiary') round-trip required fields", () => {
    expect(parseLoan(toPlaintext("loan", { lender: "Wells Fargo" })).lender).toBe("Wells Fargo");
    expect(parseBeneficiary(toPlaintext("beneficiary", { fullName: "Sam Lee" })).fullName).toBe("Sam Lee");
  });

  it("toPlaintext('vault') returns the raw note string (no JSON)", () => {
    expect(toPlaintext("vault", { note: "remember the safe code" })).toBe("remember the safe code");
  });

  it("throws MissingRequiredFieldError when a required field is missing or blank", () => {
    expect(() => toPlaintext("account", {})).toThrowError(MissingRequiredFieldError);
    expect(() => toPlaintext("account", { institution: "   " })).toThrowError(MissingRequiredFieldError);
    try {
      toPlaintext("vault", {});
    } catch (e) {
      expect(e).toBeInstanceOf(MissingRequiredFieldError);
      expect((e as MissingRequiredFieldError).field).toBe("note");
    }
  });

  it("buildProposeRecordJsonSchema yields one oneOf branch per type with the discriminant + required keys", () => {
    const schema = buildProposeRecordJsonSchema() as {
      oneOf: { properties: { type: { enum: string[] } }; required: string[] }[];
    };
    expect(schema.oneOf).toHaveLength(5);
    const account = schema.oneOf.find((b) => b.properties.type.enum[0] === "account")!;
    expect(account.required).toContain("type");
    expect(account.required).toContain("institution");
    const vault = schema.oneOf.find((b) => b.properties.type.enum[0] === "vault")!;
    expect(vault.required).toContain("note");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/assistant/record-schemas.test.ts`
Expected: FAIL — cannot find module `@/lib/assistant/record-schemas`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/assistant/record-schemas.ts
import { serializeAccount, type Account, type AccountType } from "@/lib/account";
import {
  serializeBill,
  type Bill,
  type BillCategory,
  type Frequency,
} from "@/lib/bill";
import { serializeLoan, type Loan, type LoanKind } from "@/lib/loan";
import {
  serializeBeneficiary,
  type Beneficiary,
  type BeneficiaryRelationship,
} from "@/lib/beneficiary";
import { type JSONSchema7 } from "ai";

export type RecordTypeKey = "account" | "bill" | "loan" | "beneficiary" | "vault";
export type FieldKind = "text" | "longtext" | "number" | "date" | "boolean";

export interface FieldSchema {
  key: string;
  label: string;
  required: boolean;
  kind: FieldKind;
  options?: readonly string[];
}

export interface RecordTypeSchema {
  key: RecordTypeKey;
  label: string;
  resource: string;
  fields: readonly FieldSchema[];
}

export type ProposedFields = Record<string, string | boolean | undefined>;

const ACCOUNT_TYPES: readonly AccountType[] = ["Checking", "Savings", "Investment", "Retirement", "Other"];
const BILL_CATEGORIES: readonly BillCategory[] = ["Utility", "Streaming", "Insurance", "Loan", "Subscription", "Other"];
const FREQUENCIES: readonly Frequency[] = ["Weekly", "Monthly", "Quarterly", "Annual", "One-time"];
const LOAN_KINDS: readonly LoanKind[] = ["Mortgage", "Auto", "Student", "Personal", "HELOC", "Other"];
const RELATIONSHIPS: readonly BeneficiaryRelationship[] = ["Spouse", "Child", "Parent", "Sibling", "Friend", "Trust", "Charity", "Other"];

export const RECORD_SCHEMAS: readonly RecordTypeSchema[] = [
  {
    key: "account",
    label: "Financial account",
    resource: "accounts",
    fields: [
      { key: "institution", label: "Institution", required: true, kind: "text" },
      { key: "type", label: "Account type", required: false, kind: "text", options: ACCOUNT_TYPES },
      { key: "nickname", label: "Nickname", required: false, kind: "text" },
      { key: "accountNumber", label: "Account number", required: false, kind: "text" },
      { key: "balance", label: "Balance", required: false, kind: "number" },
      { key: "notes", label: "Notes", required: false, kind: "longtext" },
    ],
  },
  {
    key: "bill",
    label: "Bill or subscription",
    resource: "bills",
    fields: [
      { key: "name", label: "Name", required: true, kind: "text" },
      { key: "category", label: "Category", required: false, kind: "text", options: BILL_CATEGORIES },
      { key: "amount", label: "Amount", required: false, kind: "number" },
      { key: "frequency", label: "Frequency", required: false, kind: "text", options: FREQUENCIES },
      { key: "nextDueDate", label: "Next due date", required: false, kind: "date" },
      { key: "paymentMethod", label: "Payment method", required: false, kind: "text" },
      { key: "autoPay", label: "Auto-pay", required: false, kind: "boolean" },
      { key: "website", label: "Website", required: false, kind: "text" },
      { key: "notes", label: "Notes", required: false, kind: "longtext" },
    ],
  },
  {
    key: "loan",
    label: "Loan or mortgage",
    resource: "loans",
    fields: [
      { key: "lender", label: "Lender", required: true, kind: "text" },
      { key: "kind", label: "Loan type", required: false, kind: "text", options: LOAN_KINDS },
      { key: "nickname", label: "Nickname", required: false, kind: "text" },
      { key: "accountNumber", label: "Account number", required: false, kind: "text" },
      { key: "originalAmount", label: "Original amount", required: false, kind: "number" },
      { key: "currentBalance", label: "Current balance", required: false, kind: "number" },
      { key: "interestRate", label: "Interest rate", required: false, kind: "text" },
      { key: "monthlyPayment", label: "Monthly payment", required: false, kind: "number" },
      { key: "nextPaymentDate", label: "Next payment date", required: false, kind: "date" },
      { key: "payoffDate", label: "Payoff date", required: false, kind: "date" },
      { key: "notes", label: "Notes", required: false, kind: "longtext" },
    ],
  },
  {
    key: "beneficiary",
    label: "Beneficiary",
    resource: "beneficiaries",
    fields: [
      { key: "fullName", label: "Full name", required: true, kind: "text" },
      { key: "relationship", label: "Relationship", required: false, kind: "text", options: RELATIONSHIPS },
      { key: "email", label: "Email", required: false, kind: "text" },
      { key: "phone", label: "Phone", required: false, kind: "text" },
      { key: "mailingAddress", label: "Mailing address", required: false, kind: "longtext" },
      { key: "allocation", label: "Allocation %", required: false, kind: "number" },
      { key: "notes", label: "Notes", required: false, kind: "longtext" },
    ],
  },
  {
    key: "vault",
    label: "Private note",
    resource: "vault",
    fields: [{ key: "note", label: "Note", required: true, kind: "longtext" }],
  },
];

export const RECORD_SCHEMA_BY_KEY: Record<RecordTypeKey, RecordTypeSchema> = Object.fromEntries(
  RECORD_SCHEMAS.map((s) => [s.key, s]),
) as Record<RecordTypeKey, RecordTypeSchema>;

export class MissingRequiredFieldError extends Error {
  constructor(public readonly field: string) {
    super(`Missing required field: ${field}`);
    this.name = "MissingRequiredFieldError";
  }
}

function str(fields: ProposedFields, key: string): string {
  const v = fields[key];
  return typeof v === "string" ? v : "";
}
function bool(fields: ProposedFields, key: string): boolean {
  return fields[key] === true;
}
function pick<T extends string>(fields: ProposedFields, key: string, options: readonly T[], fallback: T): T {
  const v = fields[key];
  return typeof v === "string" && (options as readonly string[]).includes(v) ? (v as T) : fallback;
}

function assertRequired(schema: RecordTypeSchema, fields: ProposedFields): void {
  for (const f of schema.fields) {
    if (!f.required) continue;
    const v = fields[f.key];
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
      throw new MissingRequiredFieldError(f.key);
    }
  }
}

export function toPlaintext(type: RecordTypeKey, fields: ProposedFields): string {
  const schema = RECORD_SCHEMA_BY_KEY[type];
  if (!schema) throw new Error(`Unknown record type: ${type}`);
  assertRequired(schema, fields);
  switch (type) {
    case "vault":
      return str(fields, "note");
    case "account": {
      const a: Account = {
        type: pick(fields, "type", ACCOUNT_TYPES, "Other"),
        institution: str(fields, "institution"),
        nickname: str(fields, "nickname"),
        accountNumber: str(fields, "accountNumber"),
        balance: str(fields, "balance"),
        notes: str(fields, "notes"),
      };
      return serializeAccount(a);
    }
    case "bill": {
      const b: Bill = {
        name: str(fields, "name"),
        category: pick(fields, "category", BILL_CATEGORIES, "Other"),
        amount: str(fields, "amount"),
        frequency: pick(fields, "frequency", FREQUENCIES, "Monthly"),
        nextDueDate: str(fields, "nextDueDate"),
        paymentMethod: str(fields, "paymentMethod"),
        autoPay: bool(fields, "autoPay"),
        website: str(fields, "website"),
        notes: str(fields, "notes"),
      };
      return serializeBill(b);
    }
    case "loan": {
      const l: Loan = {
        kind: pick(fields, "kind", LOAN_KINDS, "Other"),
        lender: str(fields, "lender"),
        nickname: str(fields, "nickname"),
        accountNumber: str(fields, "accountNumber"),
        originalAmount: str(fields, "originalAmount"),
        currentBalance: str(fields, "currentBalance"),
        interestRate: str(fields, "interestRate"),
        monthlyPayment: str(fields, "monthlyPayment"),
        nextPaymentDate: str(fields, "nextPaymentDate"),
        payoffDate: str(fields, "payoffDate"),
        notes: str(fields, "notes"),
      };
      return serializeLoan(l);
    }
    case "beneficiary": {
      const bn: Beneficiary = {
        fullName: str(fields, "fullName"),
        relationship: pick(fields, "relationship", RELATIONSHIPS, "Other"),
        email: str(fields, "email"),
        phone: str(fields, "phone"),
        mailingAddress: str(fields, "mailingAddress"),
        allocation: str(fields, "allocation"),
        notes: str(fields, "notes"),
      };
      return serializeBeneficiary(bn);
    }
  }
}

function fieldToJsonSchema(f: FieldSchema): JSONSchema7 {
  if (f.kind === "boolean") return { type: "boolean", description: f.label };
  if (f.options) return { type: "string", enum: [...f.options], description: f.label };
  return { type: "string", description: f.label };
}

function branch(schema: RecordTypeSchema): JSONSchema7 {
  const properties: Record<string, JSONSchema7> = {
    type: { type: "string", enum: [schema.key], description: `Use for: ${schema.label}` },
  };
  const required: string[] = ["type"];
  for (const f of schema.fields) {
    properties[f.key] = fieldToJsonSchema(f);
    if (f.required) required.push(f.key);
  }
  return { type: "object", additionalProperties: false, properties, required };
}

export function buildProposeRecordJsonSchema(): JSONSchema7 {
  return {
    type: "object",
    description:
      "A single proposed Legacy record. Pick the matching `type` and fill the fields you know; leave unknown fields out.",
    oneOf: RECORD_SCHEMAS.map(branch),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/assistant/record-schemas.test.ts`
Expected: PASS (all assertions).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/assistant/record-schemas.ts src/lib/assistant/record-schemas.test.ts
git commit -m "feat: add assistant field-schema registry, toPlaintext, and propose-record JSON schema"
```

---

### Task 2: Assistant system prompt

**Files:**
- Create: `src/lib/assistant/prompt.ts`
- Test: `src/lib/assistant/prompt.test.ts`

**Interfaces:**
- Consumes: `RECORD_SCHEMAS` from `@/lib/assistant/record-schemas`.
- Produces: `function buildAssistantSystemPrompt(): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/assistant/prompt.test.ts
import { describe, it, expect } from "vitest";
import { buildAssistantSystemPrompt } from "@/lib/assistant/prompt";

describe("buildAssistantSystemPrompt", () => {
  const prompt = buildAssistantSystemPrompt();

  it("names every record type key", () => {
    for (const key of ["account", "bill", "loan", "beneficiary", "vault"]) {
      expect(prompt).toContain(key);
    }
  });

  it("instructs the model to call proposeRecord, one record at a time", () => {
    expect(prompt).toContain("proposeRecord");
    expect(prompt.toLowerCase()).toContain("one record at a time");
  });

  it("lists at least one required field and states it never sees saved records", () => {
    expect(prompt).toContain("institution");
    expect(prompt.toLowerCase()).toContain("never see");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/assistant/prompt.test.ts`
Expected: FAIL — cannot find module `@/lib/assistant/prompt`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/assistant/prompt.ts
import { RECORD_SCHEMAS } from "@/lib/assistant/record-schemas";

export function buildAssistantSystemPrompt(): string {
  const types = RECORD_SCHEMAS.map((s) => {
    const required = s.fields.filter((f) => f.required).map((f) => f.key);
    const all = s.fields.map((f) => f.key);
    return `- ${s.key} (${s.label}): fields ${all.join(", ")}. Required: ${required.join(", ") || "none"}.`;
  }).join("\n");

  return [
    "You are Legacy's record-keeping assistant. You help the user capture estate-planning records by talking with them in plain, warm language.",
    "",
    "You can propose any of these record types:",
    types,
    "",
    "Guidelines:",
    "- Ask brief, friendly follow-up questions ONLY for required fields that are still missing or ambiguous. Never interrogate the user about optional fields.",
    "- Propose ONE record at a time. When you have enough for a record, call the `proposeRecord` tool with the matching `type` and the fields you have gathered. Leave fields you don't know out of the call.",
    "- After a record is saved, offer to help the user add another.",
    "- You never see the user's existing saved records — they are encrypted. Work only from what the user tells you in this conversation.",
    "- Keep replies short.",
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/assistant/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/assistant/prompt.ts src/lib/assistant/prompt.test.ts
git commit -m "feat: add assistant system prompt builder"
```

---

### Task 3: Chat route with the `proposeRecord` tool

**Files:**
- Create: `src/app/api/assistant/chat/route.ts`
- Test: `src/app/api/assistant/chat/route.test.ts`

**Interfaces:**
- Consumes: `requireUserId` from `@/lib/route-auth`; `readJsonBody` from `@/lib/http`; `buildAssistantSystemPrompt` from `@/lib/assistant/prompt`; `buildProposeRecordJsonSchema` from `@/lib/assistant/record-schemas`; `streamText`, `tool`, `jsonSchema`, `convertToModelMessages`, `type UIMessage` from `ai`; `anthropic` from `@ai-sdk/anthropic`.
- Produces: `export const MODEL_ID: string`; `export async function POST(req: Request): Promise<Response>`.

**Note (verify before coding, per Global Constraints):** confirm in `node_modules/ai/dist/index.d.ts` that `streamText`, `tool`, `jsonSchema`, `convertToModelMessages`, and `UIMessage` are exported and that `streamText(...).toUIMessageStreamResponse()` exists (all confirmed present at plan time for `ai@7.0.5`).

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/assistant/chat/route.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getSessionUserId = vi.fn();
const streamTextMock = vi.fn();

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "sid-123" }) }),
}));
vi.mock("@/lib/auth", () => ({
  getSessionUserId: (...args: unknown[]) => getSessionUserId(...args),
}));
vi.mock("@ai-sdk/anthropic", () => ({ anthropic: (id: string) => ({ modelId: id }) }));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: (...args: unknown[]) => streamTextMock(...args),
}));

import { POST } from "@/app/api/assistant/chat/route";

function postReq(body: unknown) {
  return new Request("http://localhost/api/assistant/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  getSessionUserId.mockReset();
  streamTextMock.mockReset();
  streamTextMock.mockReturnValue({ toUIMessageStreamResponse: () => new Response("stream") });
  process.env.ANTHROPIC_API_KEY = "test-key";
});
afterEach(() => {
  process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
});

describe("POST /api/assistant/chat", () => {
  it("returns 401 when unauthenticated and never calls the model", async () => {
    getSessionUserId.mockResolvedValue(null);
    const res = await POST(postReq({ messages: [] }));
    expect(res.status).toBe(401);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("returns 500 when ANTHROPIC_API_KEY is absent", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    delete process.env.ANTHROPIC_API_KEY;
    const res = await POST(postReq({ messages: [] }));
    expect(res.status).toBe(500);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("streams a response and wires the proposeRecord tool when authenticated", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    const res = await POST(postReq({ messages: [] }));
    expect(res.status).toBe(200);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const arg = streamTextMock.mock.calls[0][0] as {
      system: string;
      tools: { proposeRecord?: unknown };
    };
    expect(typeof arg.system).toBe("string");
    expect(arg.tools.proposeRecord).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/assistant/chat/route.test.ts`
Expected: FAIL — cannot find module `@/app/api/assistant/chat/route`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/api/assistant/chat/route.ts
import { NextResponse } from "next/server";
import {
  streamText,
  tool,
  jsonSchema,
  convertToModelMessages,
  type UIMessage,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { requireUserId } from "@/lib/route-auth";
import { readJsonBody } from "@/lib/http";
import { buildAssistantSystemPrompt } from "@/lib/assistant/prompt";
import { buildProposeRecordJsonSchema } from "@/lib/assistant/record-schemas";

export const MODEL_ID = "claude-opus-4-8";

// No `execute`: the model only PROPOSES a record. The client renders an
// editable card and performs the (client-encrypted) save itself.
const proposeRecord = tool({
  description:
    "Propose a single Legacy record for the user to review and save. Call this only once you have enough detail for one record.",
  inputSchema: jsonSchema(buildProposeRecordJsonSchema()),
});

export async function POST(req: Request) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const messages = (body.messages ?? []) as UIMessage[];

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "The assistant is not configured." }, { status: 500 });
  }

  const result = streamText({
    model: anthropic(MODEL_ID),
    system: buildAssistantSystemPrompt(),
    messages: convertToModelMessages(messages),
    tools: { proposeRecord },
    // Errors after the streamed 200 begins can't change the status code; log
    // them. The client surfaces a failure when the stream errors/arrives empty.
    onError: ({ error }) => {
      console.error("[assistant/chat] streamText error:", error);
    },
  });
  return result.toUIMessageStreamResponse();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/assistant/chat/route.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full gates**

Run: `npm test && npx tsc --noEmit`
Expected: all tests pass; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/assistant/chat/route.ts src/app/api/assistant/chat/route.test.ts
git commit -m "feat: add assistant chat route with no-execute proposeRecord tool"
```

---

### Task 4: `useAssistant` orchestration hook (adds `@ai-sdk/react`)

**Files:**
- Create: `src/app/providers/useAssistant.ts`
- Modify: `package.json` (add `@ai-sdk/react`)

**Interfaces:**
- Consumes: `useChat` from `@ai-sdk/react`; `DefaultChatTransport`, `isToolUIPart`, `getToolName`, `type UIMessage` from `ai`; `useKey` from `@/app/providers/KeyProvider`; `encryptItem` from `@/lib/crypto`; `api` from `@/lib/api-client`; `toPlaintext`, `RECORD_SCHEMA_BY_KEY`, `MissingRequiredFieldError`, `type RecordTypeKey`, `type ProposedFields` from `@/lib/assistant/record-schemas`.
- Produces:
  - `interface PendingProposal { toolCallId: string; type: RecordTypeKey; fields: ProposedFields }`
  - `function useAssistant(): { messages: UIMessage[]; status: string; send: (text: string) => void; pendingProposal: PendingProposal | null; confirmProposal: (type: RecordTypeKey, fields: ProposedFields) => Promise<void>; discardProposal: () => Promise<void>; savedNotice: string | null; error: string | null; masterKey: ReturnType<typeof useKey>["masterKey"] }`

**Verify before coding (per Global Constraints — these are the v7 API points most exposed to drift):** after installing `@ai-sdk/react`, open its `dist/index.d.ts` and confirm the `useChat` return shape exposes `messages`, `sendMessage`, `addToolResult`, and `status`, and that `addToolResult` takes `{ tool, toolCallId, output }`. Confirm `DefaultChatTransport`, `isToolUIPart`, `getToolName` are exported from `ai` (confirmed present at plan time) and that a tool UI part has `state`, `input`, and `toolCallId`. Adjust the property names below if the installed types differ — the control flow stays the same.

- [ ] **Step 1: Install the React binding**

Run: `npm install @ai-sdk/react`
Expected: `@ai-sdk/react` added to `dependencies`; lockfile updated.

- [ ] **Step 2: Confirm the v7 surface**

Run: `node -e "const t=require('fs').readFileSync('node_modules/@ai-sdk/react/dist/index.d.ts','utf8'); for (const s of ['useChat','sendMessage','addToolResult','status']) console.log(s, t.includes(s))"`
Expected: each prints `true`. (If `addToolResult` differs, note the actual signature and adapt Step 3.)

- [ ] **Step 3: Write the hook**

```ts
// src/app/providers/useAssistant.ts
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  isToolUIPart,
  getToolName,
  type UIMessage,
} from "ai";
import { useKey } from "@/app/providers/KeyProvider";
import { encryptItem } from "@/lib/crypto";
import { api } from "@/lib/api-client";
import {
  toPlaintext,
  RECORD_SCHEMA_BY_KEY,
  MissingRequiredFieldError,
  type RecordTypeKey,
  type ProposedFields,
} from "@/lib/assistant/record-schemas";

export interface PendingProposal {
  toolCallId: string;
  type: RecordTypeKey;
  fields: ProposedFields;
}

function findPendingProposal(messages: UIMessage[]): PendingProposal | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const part of messages[i].parts) {
      if (
        isToolUIPart(part) &&
        getToolName(part) === "proposeRecord" &&
        part.state === "input-available"
      ) {
        const input = (part.input ?? {}) as { type?: RecordTypeKey } & ProposedFields;
        if (input.type && RECORD_SCHEMA_BY_KEY[input.type]) {
          const { type, ...fields } = input;
          return { toolCallId: part.toolCallId, type, fields };
        }
      }
    }
  }
  return null;
}

export function useAssistant() {
  const router = useRouter();
  const { masterKey } = useKey();
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chat = useChat({
    transport: new DefaultChatTransport({ api: "/api/assistant/chat" }),
    onError: () => setError("The assistant hit a snag. Please try again."),
  });

  useEffect(() => {
    if (!masterKey) router.replace("/unlock");
  }, [masterKey, router]);

  const pendingProposal = useMemo(
    () => findPendingProposal(chat.messages as UIMessage[]),
    [chat.messages],
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setError(null);
      setSavedNotice(null);
      chat.sendMessage({ text: trimmed });
    },
    [chat],
  );

  const confirmProposal = useCallback(
    async (type: RecordTypeKey, fields: ProposedFields) => {
      if (!masterKey || !pendingProposal) return;
      setError(null);
      try {
        const plaintext = toPlaintext(type, fields);
        const { ciphertext, iv } = await encryptItem(masterKey, plaintext);
        await api.addRecord(RECORD_SCHEMA_BY_KEY[type].resource, ciphertext, iv);
        setSavedNotice(`Saved your ${RECORD_SCHEMA_BY_KEY[type].label.toLowerCase()}.`);
        await chat.addToolResult({
          tool: "proposeRecord",
          toolCallId: pendingProposal.toolCallId,
          output: { saved: true, type },
        });
      } catch (e) {
        if (e instanceof MissingRequiredFieldError) {
          setError(`Please fill in the ${e.field} field before saving.`);
        } else {
          setError("We couldn't save that. Please try again.");
        }
      }
    },
    [masterKey, pendingProposal, chat],
  );

  const discardProposal = useCallback(async () => {
    if (!pendingProposal) return;
    setSavedNotice(null);
    await chat.addToolResult({
      tool: "proposeRecord",
      toolCallId: pendingProposal.toolCallId,
      output: { saved: false },
    });
  }, [pendingProposal, chat]);

  return {
    messages: chat.messages as UIMessage[],
    status: chat.status,
    send,
    pendingProposal,
    confirmProposal,
    discardProposal,
    savedNotice,
    error,
    masterKey,
  };
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (If errors point at `useChat`/`addToolResult` shapes, adapt to the confirmed installed types from Step 2 — keep the control flow.)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/app/providers/useAssistant.ts
git commit -m "feat: add useAssistant hook over @ai-sdk/react useChat"
```

---

### Task 5: `ProposalCard` editable component

**Files:**
- Create: `src/components/assistant/ProposalCard.tsx`

**Interfaces:**
- Consumes: `RECORD_SCHEMA_BY_KEY`, `type RecordTypeKey`, `type ProposedFields`, `type FieldSchema` from `@/lib/assistant/record-schemas`.
- Produces: `function ProposalCard(props: { type: RecordTypeKey; initialFields: ProposedFields; onSave: (type: RecordTypeKey, fields: ProposedFields) => void; onDiscard: () => void; error: string | null }): JSX.Element`

- [ ] **Step 1: Write the component**

```tsx
// src/components/assistant/ProposalCard.tsx
"use client";

import { useState } from "react";
import {
  RECORD_SCHEMA_BY_KEY,
  type RecordTypeKey,
  type ProposedFields,
  type FieldSchema,
} from "@/lib/assistant/record-schemas";

export function ProposalCard(props: {
  type: RecordTypeKey;
  initialFields: ProposedFields;
  onSave: (type: RecordTypeKey, fields: ProposedFields) => void;
  onDiscard: () => void;
  error: string | null;
}) {
  const schema = RECORD_SCHEMA_BY_KEY[props.type];
  const [fields, setFields] = useState<ProposedFields>(props.initialFields);

  function setField(key: string, value: string | boolean) {
    setFields((f) => ({ ...f, [key]: value }));
  }

  const missingRequired = schema.fields
    .filter((f) => f.required)
    .some((f) => {
      const v = fields[f.key];
      return v === undefined || (typeof v === "string" && v.trim() === "");
    });

  return (
    <div className="item">
      <p className="subtle">
        Review this {schema.label.toLowerCase()} — it saves to your encrypted vault only when you click Save.
      </p>
      {schema.fields.map((f: FieldSchema) => {
        const id = `proposal-${f.key}`;
        const value = fields[f.key];
        if (f.kind === "boolean") {
          return (
            <label key={f.key} htmlFor={id}>
              <input
                id={id}
                type="checkbox"
                checked={value === true}
                onChange={(e) => setField(f.key, e.target.checked)}
              />{" "}
              {f.label}
            </label>
          );
        }
        const text = typeof value === "string" ? value : "";
        return (
          <div key={f.key}>
            <label htmlFor={id}>
              {f.label}
              {f.required ? " *" : ""}
            </label>
            {f.options ? (
              <select id={id} value={text} onChange={(e) => setField(f.key, e.target.value)}>
                <option value="">—</option>
                {f.options.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            ) : f.kind === "longtext" ? (
              <textarea id={id} value={text} onChange={(e) => setField(f.key, e.target.value)} />
            ) : (
              <input
                id={id}
                type={f.kind === "date" ? "date" : "text"}
                value={text}
                onChange={(e) => setField(f.key, e.target.value)}
              />
            )}
          </div>
        );
      })}
      {props.error && <p className="error">{props.error}</p>}
      <div className="row">
        <button type="button" disabled={missingRequired} onClick={() => props.onSave(props.type, fields)}>
          Save
        </button>
        <button type="button" className="linkbtn" onClick={props.onDiscard}>
          Discard
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/assistant/ProposalCard.tsx
git commit -m "feat: add editable ProposalCard for assistant record proposals"
```

---

### Task 6: `/assistant` page + nav link

**Files:**
- Create: `src/app/assistant/page.tsx`
- Modify: `src/components/AppNav.tsx`

**Interfaces:**
- Consumes: `useAssistant` from `@/app/providers/useAssistant`; `ProposalCard` from `@/components/assistant/ProposalCard`; `AppNav` from `@/components/AppNav`; `LegacyMark` from `@/components/Logo`; `isToolUIPart`, `type UIMessage` from `ai`.

- [ ] **Step 1: Add the nav link**

In `src/components/AppNav.tsx`, add an Assistant link after the Obituary link inside `.navlinks`:

```tsx
        <Link href="/obituary">Obituary</Link>
        <Link href="/assistant">Assistant</Link>
```

- [ ] **Step 2: Write the page**

```tsx
// src/app/assistant/page.tsx
"use client";

import { useState } from "react";
import { isToolUIPart, type UIMessage } from "ai";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { useAssistant } from "@/app/providers/useAssistant";
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

export default function AssistantPage() {
  const {
    messages,
    status,
    send,
    pendingProposal,
    confirmProposal,
    discardProposal,
    savedNotice,
    error,
    masterKey,
  } = useAssistant();
  const [input, setInput] = useState("");

  if (!masterKey) return null;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    send(input);
    setInput("");
  }

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Assistant</h1>
        <p className="subtle">
          Describe a record in your own words and I’ll help you save it. This chat isn’t stored — only the
          records you choose to save are kept, encrypted on your device.
        </p>

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
            placeholder="e.g. Add my Wells Fargo mortgage, about 280k left at 6.1%"
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
```

Note: `MessageText` renders only text parts; tool parts are handled by the `ProposalCard` block, so `isToolUIPart` is imported for clarity of intent even though the transcript filter is by `p.type === "text"`. If `npx tsc --noEmit` flags `isToolUIPart` as unused, drop it from the import.

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/assistant/page.tsx src/components/AppNav.tsx
git commit -m "feat: add /assistant page and nav link"
```

---

### Task 7: Manual verification + final gates

**Files:** none (verification only).

This task proves the streaming + tool-call + encrypt-and-save flow that the node test harness cannot (no jsdom, and mocking the v7 tool-call stream is brittle). Requires `ANTHROPIC_API_KEY` in `.env` and a running dev server against the dev DB.

- [ ] **Step 1: Run all automated gates**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: all pass.

- [ ] **Step 2: Start the app and sign in / unlock the vault**

Use the `run` skill (or `npm run dev`). Register/log in and unlock so a `masterKey` is present. Navigate to `/assistant` — confirm it renders (not redirected to `/unlock`).

- [ ] **Step 3: Drive a capture end-to-end**

Type: `Add my Wells Fargo mortgage, about 280k left at 6.1%`. Confirm:
- the assistant streams a reply and (after any follow-up about the lender/type) renders a `ProposalCard` of type **loan** with `lender` = Wells Fargo and `currentBalance`/`interestRate` populated;
- editing a field updates the card; **Save** is disabled until required fields are filled;
- clicking **Save** shows "Saved your loan or mortgage." and the card disappears;
- open `/loans` — the new loan appears and decrypts correctly (proves byte-identical `serialize`).

- [ ] **Step 4: Verify a second type and discard**

Add a vault note ("remember the safe code is 1234") → Save → confirm it shows on `/vault`. Trigger another proposal and click **Discard** → confirm the card disappears and nothing is saved.

- [ ] **Step 5: Verify the no-persistence / ZK posture**

Refresh `/assistant` → the transcript is empty (ephemeral). Confirm via DevTools Network that requests to `/api/assistant/chat` carry only chat messages, and that saves go to `/api/<type>` as `{ ciphertext, iv }` (no plaintext record fields).

- [ ] **Step 6: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "fix: address assistant verification findings"
```

(Skip if Steps 1–5 passed with no changes.)

---

## Self-Review

**1. Spec coverage:**
- Vault-gated `/assistant` multi-turn chat → Tasks 4 (gate), 6 (page). ✓
- All five record types via NL → Task 1 registry; Task 2 prompt. ✓
- Tool-calling engine (`streamText` + `proposeRecord`, no `execute`, client-intercepted) → Task 3 (route), Task 4 (hook detection + `addToolResult`). ✓
- Field-schema registry as single source of truth (tool schema + card + `toPlaintext` via existing `serialize`) → Tasks 1, 5. ✓
- Editable preview card → Save → client encrypt → existing `addRecord` → Tasks 4, 5. ✓
- Ephemeral transcript / zero new server-side plaintext → Task 3 (persists nothing), Task 7 Step 5 (verified). ✓
- Error handling (AI failure, save failure, required-field gap, lost key, malformed payload) → Task 4 (`onError`, try/catch, `MissingRequiredFieldError`), Task 5 (disabled Save), Task 4 (`router.replace`), Task 4 (`findPendingProposal` guards on known `type`). ✓
- Testing scope (pure libs + route; UI/stream manual) → Tasks 1–3 automated, Task 7 manual; stated in Global Constraints. ✓
- Dependencies (`@ai-sdk/react` new; no `zod`; `jsonSchema()`) → Task 4 Step 1; Task 1 uses `jsonSchema` JSON-schema input. ✓
- Out of scope (edit/delete, Q&A, interview, transcript persistence, multi-record/message) → not built; create-only. ✓

**2. Placeholder scan:** No `TBD`/`TODO`/"add error handling"/"write tests for the above" remain; all code steps carry complete, runnable code.

**3. Type consistency:** `toPlaintext(type, fields)`, `RECORD_SCHEMA_BY_KEY`, `MissingRequiredFieldError.field`, `ProposedFields`, `RecordTypeKey`, and `PendingProposal { toolCallId, type, fields }` are used consistently across Tasks 1, 4, 5. `proposeRecord` tool name matches between Task 3 (route), Task 4 (`getToolName === "proposeRecord"`, `addToolResult({ tool: "proposeRecord" })`). Resource strings (`accounts`/`bills`/`loans`/`beneficiaries`/`vault`) match the real `/api/<resource>` routes and `api.addRecord`. `MODEL_ID` matches the obituary route convention.
