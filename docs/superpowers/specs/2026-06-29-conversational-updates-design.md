# Conversational Updates — Conversational Capture Engine (Slice A) — Design

**Date:** 2026-06-29
**Sprint:** 3 (AI Assistant) — Slice 3 (the conversational assistant)
**Status:** Approved (brainstorming), ready for implementation planning

## Summary

A vault-gated `/assistant` page with a multi-turn chat. The user describes a
record in natural language ("add my Wells Fargo mortgage, about 280k left at
6.1%"); the AI model asks brief follow-ups for any missing required fields, then
proposes a structured record. The proposal renders as an **editable preview
card**; on **Save** the browser encrypts it (`encryptItem`) and persists it
through the existing append-only `/api/<type>` route. The assistant can create
any of the five encrypted record types (vault notes, financial accounts, bills,
loans, beneficiaries). The chat transcript is **ephemeral** — never stored.

This is the foundational **engine** for the larger "conversational updates"
vision. Two follow-on slices reuse it without re-architecting:

- **Slice B — edit/delete via chat:** adds `editRecord`/`deleteRecord` tools and
  the (separate) decision to show one decrypted record to the model.
- **Slice C — Q&A / guidance + proactive interview:** the read-heavy slice with
  the broadest ZK surface.

Slice A is deliberately the **create-only, zero-knowledge-clean** piece — one
honest ZK decision, matching how the obituary and readiness slices were each
scoped.

## The zero-knowledge boundary (stated precisely)

The master key is derived in the browser and never sent to the server; the
server persists only `{ ciphertext, iv }` blobs (see `AGENTS.md` →
"Zero-knowledge invariant"). This feature preserves that exactly:

- The model sees **only what the user types into the chat** — brand-new data the
  user is volunteering, exactly as if they typed it into one of the per-type
  forms. It **never** sees existing vault ciphertext or any decrypted record.
- The chat route **persists nothing**. The transcript lives only in the browser
  tab for the session (refresh = fresh chat).
- Encryption happens **client-side on Save**, unchanged. The only data at rest
  from this feature is the same `{ ciphertext, iv }` blobs the forms already
  produce.
- **Net new server-side plaintext: zero.** (The obituary slice introduced
  plaintext at rest; this slice does not.)

Because the browser must encrypt on Save, the page is **vault-gated** (requires
the master key), unlike the login-only obituary page. The chat *route* itself
only needs an authenticated session — the key never reaches the server — but the
page will not call it without a master key present.

## The single source of truth — a field-schema registry

`src/lib/assistant/record-schemas.ts` holds one descriptor per record type: its
fields (`key`, `label`, `required`, `kind: "text" | "number" | "date" |
"longtext"`). This registry is the one place the five types are described, and it
serves three consumers:

1. It generates the `proposeRecord` tool's input schema — a discriminated union
   on `type` — via the AI SDK's `jsonSchema()` helper (no `zod` dependency).
2. It drives the editable preview card's field rendering and required-field
   validation.
3. `toPlaintext(type, fields)` validates required fields and delegates to that
   type's **existing** pure `serialize` from `src/lib/<type>.ts`, producing the
   exact same plaintext shape the forms produce.

Consequence of (3): records saved via the assistant are **indistinguishable**
from form-entered records and decrypt identically on their own pages. Adding a
future record type to the assistant is one registry entry.

## Components & boundaries

### `src/lib/assistant/record-schemas.ts` (pure, unit-tested)

- `RECORD_SCHEMAS` — descriptor per type (the five field-schemas).
- `proposeRecordInputSchema` — the discriminated-union JSON schema for the tool,
  built from `RECORD_SCHEMAS` via the AI SDK `jsonSchema()` helper.
- `toPlaintext(type, fields)` — validates required fields, then calls the
  per-type `serialize`. Throws / returns a typed error on missing required
  fields. Pure, no IO.

### `src/lib/assistant/prompt.ts` (pure, unit-tested)

- `buildAssistantSystemPrompt(): string` — instructs the model: help the user
  capture estate records; it can propose any of the five types; ask brief
  follow-ups for **required** fields only; call `proposeRecord` once it has
  enough; propose one record at a time. Pure string-builder, tested like
  `buildObituaryPrompt`.

### `src/app/api/assistant/chat/route.ts`

- `POST`. Requires an authenticated session (`requireUserId` → 401 otherwise).
- Reads `{ messages }`; calls
  `streamText({ model: anthropic(MODEL_ID), system: buildAssistantSystemPrompt(),
  messages, tools: { proposeRecord } })` and returns the streamed response.
- `proposeRecord` is a **tool with no server-side `execute`** — the tool call is
  forwarded to the client, which renders the card and performs the save. The
  server never executes a save and never persists anything.
- `MODEL_ID` is a single module constant (default `claude-opus-4-8`; one-line
  swap to `claude-sonnet-4-6` to cut cost), mirroring the obituary route.
- Provider: `@ai-sdk/anthropic` (already a dependency), `ANTHROPIC_API_KEY` from
  the environment (already configured).

### `src/app/providers/useAssistant.ts` (orchestration hook)

Wraps the AI SDK React chat hook (`useChat` from `@ai-sdk/react`). Exposes
`{ messages, input, setInput, send, status, pendingProposal, savedNotice, error,
masterKey }`.

1. Gate: if no `masterKey`, redirect to `/unlock` and bail (same pattern as
   `useEncryptedRecords`).
2. Streams chat turns via the chat route.
3. Detects a `proposeRecord` tool call in the stream → exposes its payload as
   `pendingProposal` (type + extracted fields).
4. On confirm (from the card): `toPlaintext(type, fields)` →
   `encryptItem(masterKey, plaintext)` → `api.addRecord(type, ciphertext, iv)` →
   append a short "Saved your {type}" note to the conversation → clear
   `pendingProposal`.
5. On save failure: surface an inline error, keep `pendingProposal` editable, do
   **not** append a saved note.

### `src/components/assistant/ProposalCard.tsx`

Renders `pendingProposal` as an editable form derived from the type's registry
descriptor (one input per field, `kind` chooses the control). Validates required
fields before enabling **Save**; offers **Discard**. Surfaces save errors inline.

### `src/app/assistant/page.tsx`

- Client component; renders `null` while redirecting if `!masterKey`.
- Chat transcript + composer; inline `ProposalCard` when a proposal is pending; a
  brief "what this does / your transcript isn't saved" line.
- Calm Legacy brand styling, consistent with the other pages.

### `src/components/AppNav.tsx`

- Add an "Assistant" nav link.

### `src/lib/api-client.ts`

- **No new save method** — reuses `addRecord(resource, ciphertext, iv)`.
- The chat stream is consumed by the `useChat` binding directly (it POSTs to
  `/api/assistant/chat`), so no bespoke api-client method for the stream.

## Data flow

1. Page loads (vault unlocked) → empty chat.
2. User types → `useAssistant.send` → `POST /api/assistant/chat` → prose streams
   back token-by-token.
3. Model asks follow-ups as needed (still streaming prose).
4. Model emits `proposeRecord` → `ProposalCard` renders the editable fields.
5. User edits/confirms → **Save** → client encrypts → `POST /api/<type>` →
   "Saved" note appended → card clears.
6. User can keep going (add another record) or refresh to start fresh (the
   transcript is ephemeral).

## Error handling

- **AI failure** (rate limit, 5xx, missing `ANTHROPIC_API_KEY`): friendly inline
  message in the chat; transcript and any pending proposal are preserved.
- **Save failure** (encrypt or POST): inline error on the card; the proposal
  stays editable so nothing is lost; no "saved" note appended.
- **Required-field gap**: the card blocks Save and highlights the missing field
  (defense-in-depth even though the model is instructed to gather them).
- **Master key lost mid-session** (lock/expiry): redirect to `/unlock`, same as
  every encrypted page.
- **Malformed tool payload**: registry validation rejects it; the card surfaces
  "I couldn't read that — let's try again" rather than crashing.

## Testing

- **Unit — `src/lib/assistant/record-schemas.test.ts`:** `toPlaintext` per type
  round-trips through the real per-type `serialize`; required-field validation
  rejects gaps; the discriminated-union schema accepts valid payloads and rejects
  malformed ones.
- **Unit — `src/lib/assistant/prompt.test.ts`:** the system prompt names all five
  types and the propose-when-ready / one-at-a-time instructions.
- **Route test — `src/app/api/assistant/chat`:** uses the AI SDK **mock model**
  (deterministic, offline, no real tokens) to assert a scripted `proposeRecord`
  tool call streams through to the client, and that the route persists nothing.
- **Gates:** `npm test` (Vitest), `npx tsc --noEmit` (typecheck), `npm run build`.
- **Live e2e — out of scope** for this slice (same rationale as obituary: it
  would consume real API tokens; and the ZK round-trip it proves does not change
  here, since Save reuses the already-e2e-covered `addRecord` path).

## Out of scope (explicit)

- **Edit / delete** of existing records (Slice B) — requires new update/delete
  endpoints and the decision to show a decrypted record to the model.
- **Q&A / guidance** over existing records, and the **proactive interview
  script** (Slice C) — the read-heavy, broadest-ZK-surface piece.
- Persisting the transcript (encrypted or plaintext).
- Multiple-records-from-one-message extraction (the model proposes one record at
  a time).
- Prefilling proposals from existing records or beneficiaries.

## Dependencies

- Reuses `ai@7` and `@ai-sdk/anthropic@4` (already added for the obituary slice).
- **New dependency:** `@ai-sdk/react` for the `useChat` chat binding.
- The tool input schema uses the AI SDK `jsonSchema()` helper — **no `zod`
  dependency** is introduced.
- `ANTHROPIC_API_KEY` — already configured.

## Notes for implementation

- Per `AGENTS.md`, read the relevant guide under `node_modules/next/dist/docs/`
  before writing the route/streaming code — this Next.js version (16.2.9) may
  differ from training data.
- Confirm the exact `streamText` tool definition, no-`execute` client-forwarding
  behavior, and `useChat` tool-call surfacing against the **installed AI SDK v7**
  (`ai@^7.0.5`, `@ai-sdk/anthropic@^4.0.2`) before writing the route and hook —
  v7 APIs differ from older training data, and the obituary spec's "v6" note is
  superseded.
- Build order suggestion for the plan: (1) `record-schemas.ts` + `prompt.ts` with
  unit tests (TDD); (2) chat route + mock-model route test; (3) `useAssistant`
  hook; (4) `ProposalCard`; (5) `assistant/page.tsx` + AppNav link; (6) final
  gates + review.
