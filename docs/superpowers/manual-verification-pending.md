# Manual verification pending — Sprint 3 AI Assistant slices

Both slices below are **code-complete, merged to `main`, and pushed**. All automated
gates are green (unit tests, `tsc`, `build`). The only outstanding step for each is a
**live smoke-test through the real UI**, which needs:

- `npm run dev` running
- a working `ANTHROPIC_API_KEY` in `.env` (already present)
- logging in and **unlocking your vault** (the assistant needs the master key)

Watch the **DevTools → Network** tab during these to confirm the zero-knowledge posture.

---

## Slice A — Conversational capture (`/assistant` create mode) — merged `b491e14`

1. **Gated load:** open `/assistant` — it renders the chat (doesn't bounce to `/unlock`).
   A new "Assistant" link is in the top nav.
2. **Capture:** type `Add my Wells Fargo mortgage, about 280k left at 6.1%`. Expect a
   streamed reply (maybe a follow-up), then an **editable card** (type *loan*) with the
   lender + balance/rate filled. Save is disabled until required fields are present.
3. **Save + persist:** Save → "Saved your loan or mortgage." → the card clears → open
   `/loans` and confirm it's there and decrypts.
4. **Second type + discard:** add a vault note ("the safe code is 1234") → Save → check
   `/vault`. Trigger another proposal → **Discard** → card disappears, nothing saved.
5. **ZK / ephemeral:** Network shows `/api/assistant/chat` carries only chat text, and
   saves go to `/api/<type>` as `{ ciphertext, iv }` only. Refresh `/assistant` → the
   transcript is empty.

Note: after a Save the assistant won't auto-offer "add another" until you type again —
expected (the saved notice is UI, not a model turn).

---

## Slice B — Conversational edit/delete — merged `aa6efb8`

1. **Page delete:** on `/accounts` (add one if empty) each card shows "Edit with
   assistant" + "Delete". Click **Delete** → "Confirm delete / Cancel". Cancel leaves
   it; Confirm removes it and the list reloads. Spot-check `/vault` too.
2. **Conversational edit — test ALL FIVE types** (the bug we fixed was that 4/5 types
   silently fell back to *create* mode): from an accounts / bills / loans / beneficiaries
   / vault card, click **Edit with assistant** → lands on `/assistant?type=…&id=…` with
   an **"Editing your …" banner**. Type a change (e.g. "change the interest rate to
   6%"). Expect a pre-filled card with the change applied and other fields intact.
   **Crucially, in Network confirm Save fires `PUT /api/<type>/<id>` — NOT `POST
   /api/<type>`.** A POST means it fell into create mode (regression).
3. **Account type preserved:** edit an account's institution only → confirm the account
   **type** (Checking/Savings/…) is unchanged after save.
4. **Delete from pinned view:** from an edit deep-link, click **Delete this record** →
   Confirm → it deletes and navigates back to the correct list page (incl. the
   `beneficiaries` and `vault` paths — these were the ones prone to a wrong-path bug).
5. **Ownership / ZK:** `PUT` and `DELETE` carry only `{ ciphertext, iv }` / an id (no
   plaintext fields). Editing/deleting a bogus or non-owned id returns **404** and the
   UI surfaces "no longer exists".

---

When both pass, Sprint 3 has only **Slice C (Q&A / guidance + proactive interview)**
left — a fresh brainstorm→spec→plan→build cycle.

---

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

---

## Sprint 4 — Survivor mode

- Survivor mode (Sprint 4 Slice 1): see `manual-verification-survivor.md`. Note: requires `SURVIVOR_SALT_SECRET` env var in `.env`/`.env.test`.

---

## Sprint 4 · Slice 3 — Verification & Hardening (live checks)

Code-complete; unit gates green. Live checks to run with `npm run dev` + dev DB
(`SURVIVOR_SALT_SECRET` set):

- [ ] `npx vitest run --config vitest.e2e.config.ts` is green (incl. the new
      body-ceiling / no-store / quota spec).
- [ ] A record POST body over 256 KB returns **413**; the documents POST accepts
      a normal ~5 MB file (body under the ~9 MB ceiling).
- [ ] DevTools → Network: record-list and document GETs carry
      `Cache-Control: no-store`.
- [ ] Survivor claim still round-trips (arm → /recover → decrypt), and a wrong
      code returns a generic 401.
