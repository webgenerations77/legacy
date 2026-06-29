<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Legacy

AI-powered life-organization / estate-planning platform: a **zero-knowledge** encrypted vault plus financial records (accounts, bills), with survivor mode and an obituary generator planned. Stack: Next.js 16 (App Router, TS strict), Prisma 6 → Railway Postgres, browser WebCrypto (PBKDF2 600k + AES-GCM), bcryptjs, Vitest.

## Zero-knowledge invariant (do not break)

The master key is derived **in the browser** from the passphrase and is never sent to the server. The server persists only ciphertext, IVs, and `bcrypt(authVerifier)` — never plaintext, never the key. All encrypt/decrypt happens client-side via `src/lib/crypto.ts` (`encryptItem`/`decryptItem`). Any feature touching user data must preserve this: the server stores opaque `{ ciphertext, iv }` blobs only.

## Encrypted-record pattern (vault, accounts, bills — and future types)

Every encrypted-record type shares one abstraction; adding a type is thin:
- **Domain lib** `src/lib/<type>.ts` — the typed object + pure `serialize`/`parse` (+ any display helpers). Pure, unit-tested.
- **Prisma model** — `{ id, userId, ciphertext, iv, createdAt }` + `User` relation (`onDelete: Cascade`); one migration applied to **both** dev (`.env`) and test (`.env.test`) DBs.
- **Route** `src/app/api/<type>/route.ts` — a one-liner: `export const { GET, POST } = createEncryptedRecordRoute({ model, listKey })` (`src/lib/encrypted-record-route.ts`).
- **Page** `src/app/<type>/page.tsx` — bespoke form + card that consumes the `useEncryptedRecords` hook (`src/app/providers/useEncryptedRecords.ts`) for the gate/redirect/load/decrypt/add/error control flow. Use `api.listRecords`/`api.addRecord` (generic; no per-type api-client methods).
- Add a nav link in `src/components/AppNav.tsx`.

Hook gotcha: pass **stable** `serialize`/`parse` references (module-level functions). The hook holds them in refs so inline lambdas won't trigger a refetch loop — but keep them stable anyway.

## Commands & verification

- Unit tests: `npm test` (Vitest; files are `*.test.ts` next to source).
- Typecheck gate: `npx tsc --noEmit` (Vitest does not type-check — always run this).
- Build gate: `npm run build`.
- **Live e2e** (NOT in `npm test`): `npx vitest run --config vitest.e2e.config.ts` against a running `npm run dev` + the dev DB. It proves the full zero-knowledge round-trip and no-plaintext storage.

## Gotchas

- Stale `.next` can make all `/api/*` 404 under Turbopack dev — stop the dev server, delete `.next`, restart. On Windows the server must be stopped before deleting `.next` (else EPERM).
- Prisma is connected to the GitHub repo: commit migrations as files (under `prisma/migrations/`) so the pipeline applies them. Confirm with the maintainer before running `prisma migrate` manually against any non-local environment.
- Two Railway Postgres instances: dev (`.env`) and test (`.env.test`); use the public proxy URL locally.

Design specs and implementation plans live under `docs/superpowers/`; the calm brand kit is in `docs/design/legacy-brand-kit/`.
