# Conversational Edit/Delete + Mutation Foundation (Slice B) — Design

**Date:** 2026-06-30
**Sprint:** 3 (AI Assistant) — Slice B (conversational updates, part 2)
**Status:** Approved (brainstorming), ready for implementation planning

## Summary

Add the ability to **edit and delete** existing encrypted records — which the app
cannot do today (the encrypted-record pattern is strictly append-only: only
`GET`+`POST`, no per-record routes, no edit/delete UI anywhere). This slice
introduces per-record mutation to the whole abstraction and exposes it two ways:

- **Delete** — a plain button (with inline confirm) on each per-type page and on
  the assistant's pinned-edit view. No AI, sends no record content.
- **Edit** — conversational: an "Edit with assistant" button on a record's card
  deep-links to `/assistant?type=<resource>&id=<id>`; the assistant decrypts that
  **single pinned record**, the user describes the change in plain language, the
  model proposes the updated fields, and Save re-encrypts client-side and `PUT`s.

It builds directly on Slice A (conversational capture): the `proposeRecord` tool,
`ProposalCard`, and `useAssistant` hook are reused; edit mode is a thin delta.

## Layers

The slice has three layers. Layers 1–2 are non-AI and ZK-neutral; layer 3 carries
the one new (scoped, consented) ZK exposure.

### Layer 1 — Per-record mutation foundation

- **`src/lib/encrypted-record-item-route.ts`** — a sibling to
  `createEncryptedRecordRoute`. `createEncryptedRecordItemRoute({ model })`
  returns `{ PUT, DELETE }`. Both are **ownership-scoped**:
  - `PUT(req, ctx)` — auth (`requireUser` → 401); read `{ ciphertext, iv }` and
    validate both are non-empty strings (→ 400, mirroring POST); then
    `delegate.updateMany({ where: { id, userId }, data: { ciphertext, iv } })`.
    If `count === 0` → **404** (the row doesn't exist or isn't the caller's).
    Returns `{ ok: true }`.
  - `DELETE(req, ctx)` — auth; `delegate.deleteMany({ where: { id, userId } })`;
    `count === 0` → **404**; else `{ ok: true }`.
  - The `id` comes from the dynamic route param. In Next 16 the handler signature
    is `(req, ctx)` where `ctx.params` is a Promise — `const { id } = await
    ctx.params` (confirm against `node_modules/next/dist/docs/` during
    implementation).
  - `updateMany`/`deleteMany` (not `update`/`delete`) are used precisely so the
    `userId` can be in the `where` clause — Prisma's `update`/`delete` accept only
    a unique selector and cannot enforce ownership atomically. The `BlobDelegate`
    interface gains `updateMany` and `deleteMany`.
- **Five dynamic routes** `src/app/api/<type>/[id]/route.ts`, each a one-liner:
  `export const { PUT, DELETE } = createEncryptedRecordItemRoute({ model })`
  (`financialAccount`/`bill`/`loan`/`beneficiary`/`vaultItem`).
- **`src/lib/api-client.ts`** — `updateRecord(resource, id, ciphertext, iv)`
  (PUT `/api/<resource>/<id>`) and `deleteRecord(resource, id)` (DELETE), each
  throwing the friendly-message error on non-ok like the existing helpers.

### Layer 2 — Page affordances

- **`useEncryptedRecords`** gains a `remove(id): Promise<boolean>` callback
  (`deleteRecord` → reload list; inline error on failure), returned alongside the
  existing `add`. (No `update` on the hook — editing flows through the assistant.)
- Each of the five per-type pages renders, per record card:
  - a **Delete** button with an **inline two-step confirm** held in component
    state ("Delete" → "Confirm / Cancel"). **Not** `window.confirm`/`alert` —
    those block the page (and, in the browser-automation context, the event
    loop). On confirm → `remove(id)`.
  - an **"Edit with assistant"** link: `<Link href={\`/assistant?type=<resource>&id=<id>\`}>`.
  - The card already has the record `id` (the hook exposes `items: { id, value }`).

### Layer 3 — Conversational edit

- **Registry addition (`src/lib/assistant/record-schemas.ts`)** — a pure inverse
  of `toPlaintext`: `parseToFields(type, plaintext): ProposedFields`. For `vault`
  it returns `{ note: plaintext }`; for the others it `JSON.parse`s the stored
  domain object and maps it back to field **keys**, including the `type →
  accountType` remap (the same collision fix from Slice A, in reverse). Symmetric
  and unit-tested against `toPlaintext`.
- **`/assistant` page** reads `searchParams` `type` + `id`:
  - **Edit mode** (both present and valid): fetch `api.listRecords(type)`, find
    the row by `id`, `decryptItem` + `parseToFields` → the pinned record's current
    fields. Render an "Editing your `<label>`" banner showing current values, a
    **Delete** button (same inline confirm → `deleteRecord` → navigate back to the
    record's page), and the chat scoped to editing.
  - **Create mode** (no params): the existing Slice-A create chat, unchanged. One
    page, two modes.
- **`useAssistant` gains `editTarget: { type, id, currentFields } | null`:**
  - When set, the chat transport's request `body` includes
    `editContext: { type, currentFields }` so the chat route can prepend it to the
    system prompt. (Provide `editContext` via `DefaultChatTransport`'s `body`
    option — confirm the exact mechanism against the installed `@ai-sdk/react`.)
  - On a `proposeRecord` tool call in edit mode, `pendingProposal.fields` is
    `currentFields` overlaid by the model's proposed changes, so the reused
    `ProposalCard` shows current values with the requested change applied and the
    user can tweak before saving.
  - `confirmProposal` **branches**: edit mode → `updateRecord(type, id, plaintext-encrypted)`
    (PUT); create mode → `addRecord` (POST). One conditional; everything else
    (encrypt client-side, `addToolOutput`, saved notice) is shared.
- **Chat route (`/api/assistant/chat`)** reads optional `editContext` from the
  body; when present, appends a current-values context line to the system prompt
  (e.g. "The user is editing this existing `<type>`. Current values: `<json>`.
  Propose an updated record reflecting their requested change; preserve fields
  they don't mention."). No new tool, no persistence change. The route still
  persists nothing.

## Data flow (edit)

1. Record card → "Edit with assistant" → `/assistant?type=<resource>&id=<id>`.
2. Assistant decrypts the pinned record (in-browser) → current fields + banner.
3. User: "change the rate to 6%."
4. Model proposes updated fields (current values supplied as edit context).
5. Pre-filled `ProposalCard` (current values + change) → user tweaks if needed → Save.
6. Client `encryptItem`s → `PUT /api/<type>/<id>` → confirmation; user returns to
   the page and sees the updated record.

## Data flow (delete)

Card (or pinned-edit view) **Delete** → inline confirm → `DELETE /api/<type>/<id>`
→ list reloads (page) or navigate back (assistant). No record content leaves the
device; only the id is sent.

## Zero-knowledge boundary

- **Delete:** sends only the record id; the server deletes the ciphertext row it
  owns (ownership enforced by `where: { id, userId }`). No model exposure.
- **Edit:** the **one** new exposure — a single, user-pinned record is decrypted
  in-browser and its current fields are sent to the model as edit context. One
  user-chosen record's plaintext to Anthropic, deliberate and consented.
- Unchanged: the server still persists only `{ ciphertext, iv }`; the updated
  record is re-encrypted client-side before the `PUT`; the master key never leaves
  the browser; the transcript stays ephemeral (nothing new persisted server-side
  beyond the updated ciphertext).

## Error handling

- **Pinned record not found / fails to decrypt:** calm "We couldn't load that
  record to edit" message; offer a link back / fall through to create mode rather
  than crashing.
- **PUT/DELETE 404** (not the caller's row, or already gone): inline "That record
  no longer exists." On the page, reload the list.
- **Delete confirm:** the two-step inline confirm prevents accidental one-click
  deletion.
- **Edit Save failure:** the `ProposalCard` stays open and editable (same as Slice
  A); no saved note.
- **Master key lost mid-flow:** redirect to `/unlock`, like every encrypted page.

## Testing

- **Unit — `record-schemas.test.ts` (extend):** `parseToFields` round-trips with
  `toPlaintext` for all five types (including `accountType` and the vault raw
  string); `parseToFields` on malformed/legacy plaintext degrades gracefully
  (returns best-effort fields, never throws).
- **Unit — `encrypted-record-item-route.test.ts`:** PUT and DELETE return 401 when
  unauthenticated (delegate not called); 404 when `updateMany`/`deleteMany` report
  `count === 0` (ownership / missing); 200 `{ ok: true }` on success with the
  correct `where: { id, userId }` and `data`; PUT returns 400 on a missing/
  non-string `ciphertext`/`iv`. Mirrors `encrypted-record-route.test.ts`'s mocking
  (mock `next/headers`, `@/lib/auth`, and `@/lib/db` delegate).
- **Gates:** `npm test`, `npx tsc --noEmit`, `npm run build`.
- **Manual (deferred, Task-7-style):** the live edit conversation (pin → describe
  → pre-filled card → PUT) and the page/pinned Delete buttons. UI + streaming have
  no node test, consistent with Slice A; verify the edited record persists and that
  only `{ ciphertext, iv }` and the single edit-context record cross the wire.

## Out of scope (explicit)

- **Conversational delete** — deletion stays a button + inline confirm (page and
  pinned-edit view). Safer for a destructive action than a chat turn, and avoids a
  second destructive tool and the model proposing deletions.
- **Free-form "find my mortgage" discovery** without pinning — that requires
  sending many decrypted records to the model (broad exposure), reserved for
  Slice C.
- **Bespoke non-AI inline edit forms** on the per-type pages — editing flows
  through the assistant.
- Bulk edit/delete; undo/restore of deleted records.

## Dependencies

- No new dependencies. Reuses `ai@7` / `@ai-sdk/anthropic` / `@ai-sdk/react`
  (Slice A), WebCrypto, Prisma. No new env vars. No schema/migration change
  (`updateMany`/`deleteMany` use existing columns).

## Notes for implementation

- Per `AGENTS.md`, confirm the Next 16 dynamic-route handler signature
  (`ctx.params` Promise) and the `@ai-sdk/react` request-`body` mechanism for
  `editContext` against the installed packages before writing those pieces.
- Build order for the plan: (1) `parseToFields` + tests; (2) item-route factory +
  tests; (3) five `[id]` routes + api-client methods; (4) `useEncryptedRecords.remove`
  + page Delete/Edit affordances; (5) `useAssistant` edit mode + chat-route
  `editContext` + `/assistant` edit-mode page; (6) gates + manual verification.
- Reuse, don't duplicate: `createEncryptedRecordItemRoute` mirrors the existing
  factory's auth/validation; the `ProposalCard` is reused verbatim; `confirmProposal`
  gains one branch, not a parallel code path.
