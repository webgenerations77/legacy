# Manual verification — Survivor mode (Sprint 4 Slice 1)

Prereq: `SURVIVOR_SALT_SECRET` is set in `.env` (and `.env.test`). Migration applied to both DBs.

1. Sign in, unlock the vault, add at least one record of each type + an obituary.
2. Go to **Survivor access** → "Set up survivor access". Confirm the recovery code shows once; copy it.
3. Reload `/survivor`. Confirm it shows "armed" and does NOT reveal the code again.
4. Open `/recover` in a private window (no session). Enter the owner email + code → "Unlock".
   - Confirm all records + obituary render read-only.
   - Confirm "Download" produces a JSON file and "Print" hides the buttons.
5. Wrong code on `/recover` → "didn't match" error, no data shown.
6. Unknown email on `/recover` → also fails generically (no enumeration).
7. Back on `/survivor`, "Regenerate code" → old code now fails at `/recover`; new code works.
8. "Remove survivor access" → `/recover` with the code now fails.
