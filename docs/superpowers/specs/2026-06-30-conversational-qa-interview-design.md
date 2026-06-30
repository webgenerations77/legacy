# Conversational Updates — Q&A + Proactive Interview (Slice C) — Design

**Date:** 2026-06-30
**Sprint:** 3 (AI Assistant) — Slice 3 (the conversational assistant), Slice C
**Status:** Approved (brainstorming), ready for implementation planning

## Summary

Upgrade the **default** `/assistant` chat (the no-`?type/id` mode) from
create-only capture into a **unified assistant** that additionally:

1. **Answers questions about existing records** ("what's my total debt?", "which
   bills are on auto-pay?", "do my beneficiary allocations add to 100%?").
2. Runs a **proactive "find what's missing" interview** that points the user at
   gaps and helps them fill those gaps via the existing capture flow.

Both capabilities are added to the **existing** chat engine (Slices A/B). The
edit mode (`/assistant?type=<resource>&id=<id>`) is untouched. The page stays
**vault-gated** (the master key is needed to decrypt records for Q&A and to
encrypt on any Save).

This is the **read-heavy** slice with the broadest zero-knowledge surface in
Sprint 3. It makes exactly one new honest ZK decision (below) and otherwise
reuses the engine.

## The zero-knowledge boundary (stated precisely)

The master key is derived in the browser and never sent to the server; the
server persists only `{ ciphertext, iv }` blobs (`AGENTS.md` →
"Zero-knowledge invariant"). Slice C preserves that exactly. It has **two**
distinct paths:

### Q&A path — the slice's one new ZK decision

- The chat route exposes a new **no-`execute` `readRecords` tool**. When the
  model needs data to answer a question, it calls `readRecords({ types })`.
- The **browser** decrypts **only the requested categories**, then returns their
  contents as the tool output via `addToolOutput`. The chat auto-continues and
  the model answers.
- Decrypted record contents therefore reach Anthropic **in-flight, on that turn
  only, and only for the categories the question needs** — a debt question reads
  loans, never the user's private vault notes.
- The route **persists nothing**; the transcript is ephemeral (refresh = fresh
  chat). **Net new server-side plaintext: zero.**
- The decision stated for a user: *"the assistant can read a category when you
  ask about it."* The UI makes every read **visible** (see UX, below) — reads are
  automatic but never silent.

### Interview path — zero-knowledge-clean

- The proactive interview only needs to know **what is missing**, not record
  contents. The client computes a **readiness digest** from `src/lib/readiness.ts`
  — per-category **status / counts / allocation-status aggregates only, with no
  record contents** — and passes it in the request body (the same body-passing
  pattern Slice B uses for `editContext`).
- The model conducts the gap conversation from the digest and fills gaps via the
  **existing** `proposeRecord` tool + `ProposalCard` + client-side encrypt-on-Save.
- No record contents leave the browser for the interview path.

### Gating

- The page remains **vault-gated** (redirect to `/unlock` if no master key),
  unchanged from Slice A. The chat *route* still only needs an authenticated
  session; the key never reaches the server.

## The read-consent UX decision (resolved)

**Auto + transparent.** When the model calls `readRecords`, the client executes
the decrypt-and-return **immediately** (no per-read Allow/Deny prompt), but
renders a **visible inline notice** in the transcript for each read (e.g.
"🔓 Read your loans to answer this"). This keeps Q&A smooth while guaranteeing the
user always sees which categories were decrypted-and-sent — reads are never
silent. (Explicit per-read consent and one-time session consent were considered
and rejected as too much friction for the value.)

## Components & boundaries

### `readRecords` tool — in `src/app/api/assistant/chat/route.ts`

- A second `tool({ description, inputSchema: jsonSchema(...) })` with **no
  `execute`** (client-forwarded, exactly like `proposeRecord`).
- Input: `{ types: RecordTypeKey[] }` — which categories to read. The enum of
  valid type keys is derived from the schema registry
  (`src/lib/assistant/record-schemas.ts`), so it stays in sync automatically.
- A new builder `buildReadRecordsJsonSchema()` lives next to
  `buildProposeRecordJsonSchema()` in the registry module.

### `src/app/providers/find-pending-read.ts` (pure, unit-tested)

- Mirror of `find-pending-proposal.ts`: scans the `UIMessage[]` stream and
  surfaces a pending `readRecords` tool call (`{ toolCallId, types }`) that has
  no output yet. Pure, no IO — unit-testable without the hook.

### `src/lib/assistant/records-digest.ts` (pure, unit-tested)

Two pure functions, the testable core of both new paths:

- `buildReadinessDigest(input): ReadinessDigest` — wraps `computeReadiness` and
  reduces its report to a **contents-free** digest the model can read:
  per-category `{ key, label, status, count, suggestion?, allocationStatus? }`.
  No record contents. Used for the interview seed.
- `serializeRecordsForModel(type, records): unknown` — turns decrypted records of
  one type into a compact, model-readable JSON shape (the parsed fields). Used to
  build the `readRecords` tool output. Pure given already-decrypted input.

### Read execution — in `src/app/providers/useAssistant.ts`

- Detect a pending `readRecords` call (via `find-pending-read`).
- For each requested `type`: `api.listRecords(resource)` → `decryptItem` per row →
  `parseToFields`/parse → `serializeRecordsForModel`.
- `chat.addToolOutput({ tool: "readRecords", toolCallId, output: { records } })`
  → the chat auto-continues so the model answers.
- Push a transparent read notice (one per category read) into the UI state the
  page renders.
- On decrypt/list failure: `addToolOutput` an error payload so the model can say
  "I couldn't read that" rather than hanging.
- Empty category: returns `[]` → model says "you don't have any … yet".

### Interview seed + digest availability — `useAssistant` + `assistant/page.tsx`

- The readiness digest is computed **lazily and cached for the session**: on the
  **first default-mode turn** (whether the user clicks the button or just types),
  the client loads + decrypts all categories once → `computeReadiness` →
  `buildReadinessDigest`, memoizes the result, and includes it in the body of
  **every default-mode turn** thereafter. It is **not** computed on page load, and
  it is recomputed only after a Save changes the record set. This keeps **both**
  interview entry points ZK-clean — a typed "what should I add?" gets the same
  contents-free digest the button does, so the model never has to read contents
  just to assess gaps.
- The "Help me find what's missing" button (rendered in **default mode only**,
  not edit mode) simply seeds the interview turn with fixed copy
  (`sendMessage("<interview seed text>", …)`); the digest rides along in the body
  like any default-mode turn.
- The chat route reads `body.readinessDigest` (like it reads `body.editContext`)
  and appends a short instruction to the system prompt when present.

### `src/lib/assistant/prompt.ts` (extended)

`buildAssistantSystemPrompt` gains guidance:
- It can **answer questions** about the user's existing records by calling
  `readRecords` with **only** the categories the question needs; it must not
  guess record contents and should call the tool instead.
- When a **readiness digest** is present, it can run a brief, warm gap-finding
  interview and offer to capture the missing records via `proposeRecord`.
- Existing capture rules (one record at a time, ask only for required fields) are
  unchanged.

### `src/app/assistant/page.tsx`

- Add the "Help me find what's missing" button (default mode only).
- Render the read notices ("🔓 Read your loans") inline in the transcript.
- Q&A answers render as ordinary assistant text via the existing `MessageText`.

### `src/lib/api-client.ts`

- **No new methods.** Reads reuse the existing `listRecords`; saves reuse
  `addRecord`. The chat stream is consumed by `useChat` directly.

## Data flow

**Q&A**

1. User: "what's my total debt?"
2. Model calls `readRecords({ types: ["loan"] })`.
3. Client decrypts loans, posts the tool output, and shows "🔓 Read your loans".
4. Chat auto-continues; model answers "Your loans total $X across 2 loans."

**Interview**

1. User clicks "Help me find what's missing".
2. Client loads + decrypts → `computeReadiness` → digest (contents-free).
3. Seeded turn sends the digest in the body.
4. Model: "You have accounts but no loans or bills yet, and your beneficiary
   allocations only add to 80% — want to start with beneficiaries?"
5. User agrees → `proposeRecord` → existing `ProposalCard` → encrypt-on-Save.

## Error handling

- **Read failure** (list or decrypt): client returns an error tool output; model
  says "I couldn't read that." Transcript preserved.
- **Empty category**: tool returns `[]`; model says "you don't have any … yet."
- **AI failure** (rate limit / 5xx / missing `ANTHROPIC_API_KEY`): existing inline
  message; transcript and any pending proposal preserved.
- **Save failure**: existing inline card error; proposal stays editable.
- **Master key lost mid-session**: redirect to `/unlock`, as every encrypted page.

## Testing

- **Unit — `records-digest.test.ts`:** `buildReadinessDigest` yields the right
  status/counts/allocation-status and **no record contents**;
  `serializeRecordsForModel` round-trips decrypted records into the compact shape
  per type.
- **Unit — `find-pending-read.test.ts`:** surfaces a pending `readRecords` call;
  ignores calls that already have output; ignores `proposeRecord`.
- **Unit — `prompt.test.ts` (extended):** the system prompt mentions
  `readRecords`, the "only needed categories / don't guess" rule, and the
  interview/digest behavior.
- **Unit — `record-schemas.test.ts` (extended):** `buildReadRecordsJsonSchema`
  accepts valid `{ types: [...] }` and rejects unknown type keys.
- **Route test (mock model):** a scripted `readRecords` call streams through to
  the client; the route **persists nothing**; the `readinessDigest` body is
  accepted and shapes the system prompt.
- **By design, no node-only test of the streaming read-execution path** (same
  rationale as Slices A/B — it requires the browser crypto + `useChat` runtime).
  The pure helpers it calls (`find-pending-read`, `records-digest`) are unit
  tested instead.
- **Live UI smoke — deferred to manual** (real API tokens + vault unlock): ask a
  Q&A question → "🔓 Read …" notice appears → correct answer; run the interview →
  proposal → Save → appears on its page; DevTools shows only `{ ciphertext, iv }`
  leaving on Save and **no plaintext persisted** by the chat route.
- **Gates:** `npm test` (Vitest), `npx tsc --noEmit`, `npm run build`.

## Out of scope (explicit)

- **Editing / deleting** records via Q&A — that remains Slice B's button + pinned
  flow. The Q&A assistant reads but never mutates.
- **Persisting transcripts** (encrypted or plaintext).
- **Per-read Allow/Deny consent** and **one-time session consent** (rejected in
  favor of auto + transparent).
- **Cross-category analytics** beyond what the model derives on the fly from the
  records it reads.
- **Multiple-records-from-one-message** extraction (the model still proposes one
  record at a time, unchanged from Slice A).
- **Auto-starting the interview on load** or per-load digest computation (the
  interview is button-or-typed, digest is lazy).

## Dependencies

- Reuses `ai@7`, `@ai-sdk/anthropic@4`, `@ai-sdk/react` — all already present.
- The `readRecords` input schema uses the AI SDK `jsonSchema()` helper — **no
  `zod` dependency** introduced.
- Reuses `src/lib/readiness.ts` (`computeReadiness`) for the digest and the
  existing `decryptItem` / `api.listRecords` / `parseToFields` for reads.
- `ANTHROPIC_API_KEY` — already configured.

## Notes for implementation

- Per `AGENTS.md`, read the relevant guide under `node_modules/next/dist/docs/`
  before touching the route/streaming code — this Next.js (16.2.x) and the
  installed AI SDK v7 differ from older training data.
- Confirm the **client-forwarded second tool** behaves like `proposeRecord`
  (no `execute` → surfaced to the client → answered via `addToolOutput` →
  auto-continue) against the installed `ai@7` / `@ai-sdk/react` before writing the
  read-execution code.
- Keep the **resource (plural) vs type-key (singular)** distinction explicit when
  mapping `readRecords` types to `api.listRecords(resource)` — the Slice B bug
  (4/5 types silently mis-resolved) came from conflating them. Resolve through the
  registry (`RECORD_SCHEMA_BY_KEY[type].resource`).
- Build order suggestion for the plan: (1) registry `buildReadRecordsJsonSchema`
  + `records-digest.ts` + `find-pending-read.ts` with unit tests (TDD); (2) prompt
  extension + test; (3) chat route `readRecords` tool + digest body + mock-model
  route test; (4) `useAssistant` read-execution + interview seed; (5) page button
  + read notices; (6) final gates + review.
