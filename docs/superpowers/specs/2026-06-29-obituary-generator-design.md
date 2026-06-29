# Obituary Generator — Design

**Date:** 2026-06-29
**Sprint:** 3 (AI Assistant) — first slice
**Status:** Approved (brainstorming), ready for implementation planning

## Summary

An AI-powered obituary generator: the user fills in a dedicated intake form
(biographical details + tone/length presets), an AI model drafts an obituary,
and the user can edit, regenerate, and save it. It is the first AI feature in
Legacy and the first feature that stores **plaintext** server-side.

## The core architectural decision

Every Sprint 2 slice used the shared **encrypted-record pattern**: the browser
encrypts with the master key and the server persists only opaque
`{ ciphertext, iv }` blobs (see `AGENTS.md` → "Encrypted-record pattern"). The
obituary generator **deliberately does not** use that pattern.

Two reasons:
1. An AI model cannot write an obituary from ciphertext — generation needs the
   biographical text in plaintext.
2. An obituary is content meant to be *shared* (survivors will read it). It is
   the opposite of a vault secret.

So the obituary is an **explicit non-vault feature**. The design's job is to make
that honest and contained:

- It lives **entirely outside** the zero-knowledge machinery. It does not touch
  `src/lib/crypto.ts`, `src/lib/encrypted-record-route.ts`, or
  `src/app/providers/useEncryptedRecords.ts`. No vault data flows through it, so
  the zero-knowledge invariant is structurally untouched.
- The page shows a plain banner so the user is never confused about where this
  data lives: *"This obituary is saved as ordinary text so it can be shared — it
  is **not** stored in your encrypted vault."*
- Because the data is not encrypted, this page needs **login only, not vault
  unlock**. A user can write an obituary without entering their passphrase. This
  is a deliberate, visible consequence of the non-vault decision.

## Use case

Supports **both** flows from one engine:
- A living user drafting their own obituary as part of estate planning.
- (Future) a survivor writing an obituary for a deceased account holder.

The intake form has a generic **subject name** field (it is not assumed to be
the logged-in user), so the same route + lib serve both flows. **Survivor mode
itself is not built yet** and is out of scope for this slice; this slice builds
the engine + the living-user flow so survivor mode can reuse it later with no
changes to the obituary route or lib.

## Components & boundaries

### Domain lib — `src/lib/obituary.ts` (pure, unit-tested)

- `ObituaryIntake` type — the structured intake (see fields below).
- `ObituaryTone` = `"Traditional" | "Warm" | "Celebratory" | "Faith-based"`.
- `ObituaryLength` = `"Short" | "Standard" | "Long"`.
- `serializeIntake(intake): string` / `parseIntake(json): ObituaryIntake` —
  pure, symmetric.
- `buildObituaryPrompt(intake): { system: string; prompt: string }` — the key
  pure function. Maps tone/length presets and the biographical fields into the
  model prompt. Length presets map to an explicit target (e.g. Short ≈ 150
  words, Standard ≈ 300, Long ≈ 500) stated in the prompt. Tone presets select
  a voice instruction. This is the real logic and is unit-tested without calling
  the model.

`ObituaryIntake` fields:
- `subjectName: string` (required) — who the obituary is about.
- `dateOfBirth: string` / `dateOfDeath: string` — free text, optional.
- `placeOrHometown: string`
- `lifeStory: string` — the main free-text biographical input.
- `family: string` — "survived by" / family details.
- `achievements: string` — career, accomplishments.
- `hobbies: string` — interests, passions.
- `tone: ObituaryTone`
- `length: ObituaryLength`
- `additionalWishes: string` — free-text "anything else" box.

(Field set may evolve; that is why intake is stored as a JSON column — see below.)

### Prisma model — `Obituary`

```
model Obituary {
  id        String   @id @default(cuid())
  userId    String   @unique
  intake    Json
  draft     String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

- `@unique` on `userId` → **one saved obituary per user** (matches the "edit +
  save one, overwrite" decision).
- `intake` is a JSON column (the form may grow; the record is never queried by
  individual field).
- `draft` is the generated-then-edited obituary text.
- One migration, committed under `prisma/migrations/`, applied to **both** the
  dev DB (`.env`) and the test DB (`.env.test`).

This model is **plaintext** — there are no `ciphertext`/`iv` columns. That is the
intended departure from the encrypted-record models.

### AI generation route — `src/app/api/obituary/generate/route.ts`

- `POST` accepts an `ObituaryIntake` body.
- Builds the prompt via `buildObituaryPrompt(intake)`.
- Calls the Vercel AI SDK: `streamText({ model: anthropic(MODEL_ID), system,
  prompt })` and returns a **streaming** text response so the draft renders
  token-by-token.
- Does **not** persist anything.
- `MODEL_ID` is a single module constant. Default: `claude-opus-4-8`. Swapping to
  `claude-sonnet-4-6` (a one-line change) cuts cost substantially if desired.
- Provider: `@ai-sdk/anthropic`, reading `ANTHROPIC_API_KEY` from the
  environment. New dependencies: `ai` and `@ai-sdk/anthropic`.
- Requires an authenticated session; **does not** require vault unlock.

### Persistence route — `src/app/api/obituary/route.ts`

- `GET` → returns the user's saved `{ intake, draft }`, or `null` if none.
- `PUT` → upserts (`prisma.obituary.upsert` keyed on `userId`) the intake +
  current draft.
- Plain JSON in and out; no encryption.
- Both require an authenticated session, not vault unlock.

### Page — `src/app/obituary/page.tsx`

- Bespoke layout: intake **form** alongside a **draft editor** (textarea).
- On load: `GET /api/obituary` hydrates the form + draft if a saved obituary
  exists.
- **Generate** → `POST /api/obituary/generate`, streaming the draft into the
  editor.
- **Regenerate** → re-streams a fresh draft from the current form.
- **Save** → `PUT /api/obituary`.
- The non-vault banner is shown prominently.
- Login gate (redirect to login if unauthenticated); **no** vault-unlock gate.

### Navigation

- Add an "Obituary" link in `src/components/AppNav.tsx`.

## Data flow

1. Page loads → `GET /api/obituary` hydrates form + draft (if previously saved).
2. User fills the intake form.
3. **Generate** → `POST /api/obituary/generate` → Claude's draft streams
   token-by-token into the editor.
4. User edits freely; **Regenerate** re-streams; **Save** → `PUT /api/obituary`
   overwrites the single saved record.

## Error handling

- AI failures (rate limit, 5xx, missing `ANTHROPIC_API_KEY`) surface as a
  friendly inline message; the form and any existing draft are preserved (no
  data loss on a failed generation).
- `PUT` validates a non-empty `subjectName` and a non-empty `draft`.
- Unauthenticated requests to either route return 401 and the page redirects to
  login.

## Testing

- **Unit** (`src/lib/obituary.test.ts`): `serializeIntake`/`parseIntake`
  round-trip; `buildObituaryPrompt` across tone × length combinations (asserts
  the prompt reflects the selected voice and target length, and includes the
  biographical fields). This is the substantive logic and is tested without the
  model.
- **Route tests:** the generate route using the AI SDK's mock model
  (deterministic, offline — no real API tokens); `GET`/`PUT` persistence tests
  for the obituary route.
- **Gates:** `npm test` (Vitest), `npx tsc --noEmit` (typecheck), `npm run build`.
- **Live e2e is out of scope** for this slice — it would consume real API tokens
  and the zero-knowledge round-trip it exists to prove does not apply to this
  (intentionally plaintext) feature.

## Out of scope (explicitly)

- Survivor mode infrastructure (the engine is built to be reused by it later).
- Multiple saved drafts / version history.
- Prefilling the form from beneficiaries or other vault records.
- PDF/print export or any publishing/sharing mechanism.

## Dependencies introduced

- `ai` (Vercel AI SDK) and `@ai-sdk/anthropic`.
- `ANTHROPIC_API_KEY` environment variable (dev `.env`; configure for the
  deployment pipeline as well).

## Notes for implementation

- Per `AGENTS.md`, read the relevant guide under `node_modules/next/dist/docs/`
  before writing route/streaming code — this Next.js version may differ from
  training data.
- Confirm the exact `streamText` / `@ai-sdk/anthropic` usage against the
  installed AI SDK version (the session targets AI SDK v6) before writing the
  route.
