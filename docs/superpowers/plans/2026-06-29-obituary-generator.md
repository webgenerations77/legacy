# Obituary Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an AI-powered obituary generator: a dedicated intake form drives a streamed Claude draft that the user can edit, regenerate, and save (one per user).

**Architecture:** This is the first **non-vault, plaintext** feature. It deliberately does **not** use the encrypted-record pattern (`crypto.ts`, `encrypted-record-route.ts`, `useEncryptedRecords`). Pure prompt logic lives in `src/lib/obituary.ts`; a new plaintext `Obituary` Prisma model stores intake (JSON) + draft; two thin routes (generate via streaming, GET/PUT persistence) are gated on **login only, not vault unlock**; a bespoke page wires the form + streamed editor.

**Tech Stack:** Next.js 16 (App Router, TS strict), Prisma 6 → Railway Postgres, Vercel AI SDK (`ai` + `@ai-sdk/anthropic`), Vitest.

## Global Constraints

- **Next.js 16.2.9 App Router, TypeScript strict.** Per `AGENTS.md`, read the relevant guide under `node_modules/next/dist/docs/` before writing route/streaming code — this Next.js version may differ from training data.
- **Zero-knowledge invariant is untouched here by construction.** This feature stores plaintext on purpose. It must NOT import or modify `src/lib/crypto.ts`, `src/lib/encrypted-record-route.ts`, or `src/app/providers/useEncryptedRecords.ts`, and must NOT route any vault data through itself.
- **Model id:** `claude-opus-4-8` (a single exported constant; swapping to `claude-sonnet-4-6` is a one-line change).
- **New dependencies:** `ai` and `@ai-sdk/anthropic`. Provider reads `ANTHROPIC_API_KEY` from the environment.
- **Prisma migrations are committed files** under `prisma/migrations/` and applied to **both** the dev DB (`.env`) and the test DB (`.env.test`).
- **Tests live in `src/**/*.test.ts`** (Vitest `include`). Gates: `npm test`, `npx tsc --noEmit`, `npm run build`.
- **Confirm the exact `streamText` / `@ai-sdk/anthropic` usage against the installed AI SDK version (v6) before writing the generate route** — verify `streamText(...)` and `.toTextStreamResponse()` against the installed package.

---

### Task 1: Obituary domain lib (`obituary.ts`)

**Files:**
- Create: `src/lib/obituary.ts`
- Test: `src/lib/obituary.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ObituaryTone = "Traditional" | "Warm" | "Celebratory" | "Faith-based"`
  - `type ObituaryLength = "Short" | "Standard" | "Long"`
  - `interface ObituaryIntake { subjectName, dateOfBirth, dateOfDeath, placeOrHometown, lifeStory, family, achievements, hobbies, tone: ObituaryTone, length: ObituaryLength, additionalWishes }` (all string except `tone`/`length`)
  - `serializeIntake(intake: ObituaryIntake): string`
  - `parseIntake(json: string): ObituaryIntake`
  - `buildObituaryPrompt(intake: ObituaryIntake): { system: string; prompt: string }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/obituary.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  serializeIntake,
  parseIntake,
  buildObituaryPrompt,
  type ObituaryIntake,
} from "@/lib/obituary";

const sample: ObituaryIntake = {
  subjectName: "Jane Doe",
  dateOfBirth: "1940-01-02",
  dateOfDeath: "2026-05-01",
  placeOrHometown: "Springfield",
  lifeStory: "A devoted teacher for forty years.",
  family: "Survived by two children.",
  achievements: "Founded the town library.",
  hobbies: "",
  tone: "Traditional",
  length: "Short",
  additionalWishes: "",
};

function intake(partial: Partial<ObituaryIntake>): ObituaryIntake {
  return { ...sample, ...partial };
}

describe("obituary domain", () => {
  it("round-trips through serialize/parse, preserving every field", () => {
    expect(parseIntake(serializeIntake(sample))).toEqual(sample);
  });

  it("builds a system prompt reflecting the tone and length presets", () => {
    const { system } = buildObituaryPrompt(sample);
    expect(system.toLowerCase()).toContain("traditional");
    expect(system).toContain("approximately 150 words");

    const faithLong = buildObituaryPrompt(
      intake({ tone: "Faith-based", length: "Long" }),
    );
    expect(faithLong.system.toLowerCase()).toContain("faith");
    expect(faithLong.system).toContain("approximately 500 words");
  });

  it("includes non-empty fields in the prompt and omits empty ones", () => {
    const { prompt } = buildObituaryPrompt(sample);
    expect(prompt).toContain("Name: Jane Doe");
    expect(prompt).toContain("Life story: A devoted teacher for forty years.");
    expect(prompt).not.toContain("Hobbies and interests:"); // hobbies is ""
    expect(prompt).not.toContain("Additional wishes:"); // additionalWishes is ""
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/obituary.test.ts`
Expected: FAIL — cannot resolve `@/lib/obituary`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/obituary.ts`:

```ts
export type ObituaryTone =
  | "Traditional"
  | "Warm"
  | "Celebratory"
  | "Faith-based";

export type ObituaryLength = "Short" | "Standard" | "Long";

export interface ObituaryIntake {
  subjectName: string;
  dateOfBirth: string;
  dateOfDeath: string;
  placeOrHometown: string;
  lifeStory: string;
  family: string;
  achievements: string;
  hobbies: string;
  tone: ObituaryTone;
  length: ObituaryLength;
  additionalWishes: string;
}

export function serializeIntake(intake: ObituaryIntake): string {
  return JSON.stringify(intake);
}

export function parseIntake(json: string): ObituaryIntake {
  return JSON.parse(json) as ObituaryIntake;
}

const TONE_VOICE: Record<ObituaryTone, string> = {
  Traditional: "Write in a respectful, formal, traditional obituary style.",
  Warm: "Write in a warm, personal, heartfelt tone.",
  Celebratory:
    "Write in an uplifting, celebratory tone that honors a life well-lived.",
  "Faith-based":
    "Write in a faith-centered tone with reverent, spiritual language.",
};

const LENGTH_WORDS: Record<ObituaryLength, number> = {
  Short: 150,
  Standard: 300,
  Long: 500,
};

export function buildObituaryPrompt(intake: ObituaryIntake): {
  system: string;
  prompt: string;
} {
  const words = LENGTH_WORDS[intake.length];
  const system = [
    "You are a compassionate obituary writer.",
    "Write a finished obituary in flowing prose, ready to publish.",
    "Output only the obituary text — no preamble, headings, commentary, or placeholders.",
    TONE_VOICE[intake.tone],
    `Aim for approximately ${words} words.`,
  ].join(" ");

  const fields: [string, string][] = [
    ["Name", intake.subjectName],
    ["Date of birth", intake.dateOfBirth],
    ["Date of death", intake.dateOfDeath],
    ["Place / hometown", intake.placeOrHometown],
    ["Life story", intake.lifeStory],
    ["Family", intake.family],
    ["Achievements", intake.achievements],
    ["Hobbies and interests", intake.hobbies],
    ["Additional wishes", intake.additionalWishes],
  ];
  const details = fields
    .filter(([, value]) => value.trim() !== "")
    .map(([label, value]) => `${label}: ${value.trim()}`)
    .join("\n");

  const prompt = `Write an obituary using these details:\n\n${details}`;
  return { system, prompt };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/obituary.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/obituary.ts src/lib/obituary.test.ts
git commit -m "feat: add obituary domain lib (intake type, serialize/parse, prompt builder)"
```

---

### Task 2: `Obituary` Prisma model + migration

**Files:**
- Modify: `prisma/schema.prisma` (add `Obituary` model + `User.obituary` relation field)

**Interfaces:**
- Consumes: nothing.
- Produces: `prisma.obituary` delegate with fields `{ id, userId @unique, intake Json, draft String, createdAt, updatedAt }`.

- [ ] **Step 1: Add the relation field to `User`**

In `prisma/schema.prisma`, inside `model User { ... }`, add this line alongside the other relations (after `beneficiaries     Beneficiary[]`):

```prisma
  obituary          Obituary?
```

- [ ] **Step 2: Add the `Obituary` model**

Append to `prisma/schema.prisma`:

```prisma
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

Note: no `ciphertext`/`iv` columns — this model is intentionally plaintext.

- [ ] **Step 3: Create + apply the migration on the dev DB**

Run: `npx prisma migrate dev --name add_obituary`
Expected: a new folder `prisma/migrations/<timestamp>_add_obituary/` with `migration.sql`, and "Your database is now in sync with your schema." The Prisma client is regenerated.

- [ ] **Step 4: Apply the committed migration to the test DB**

Run: `npx dotenv -e .env.test -- prisma migrate deploy`
Expected: "All migrations have been successfully applied." (the `add_obituary` migration is applied to the test database).

- [ ] **Step 5: Verify the client typechecks**

Run: `npx tsc --noEmit`
Expected: PASS (no errors). `prisma.obituary` is now typed.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add plaintext Obituary model + migration (dev + test DBs)"
```

---

### Task 3: Route auth helper (`route-auth.ts`)

**Files:**
- Create: `src/lib/route-auth.ts`
- Test: `src/lib/route-auth.test.ts`

**Interfaces:**
- Consumes: `getSessionUserId` from `@/lib/auth`, `SESSION_COOKIE` from `@/lib/session-cookie`, `cookies` from `next/headers`.
- Produces: `requireUserId(): Promise<string | null>` — resolves the logged-in user id from the session cookie, or `null`. (Login gate; does not check vault unlock.)

- [ ] **Step 1: Write the failing test**

Create `src/lib/route-auth.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const getSessionUserId = vi.fn();
let cookieValue: string | undefined;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (cookieValue === undefined ? undefined : { value: cookieValue }),
  }),
}));
vi.mock("@/lib/auth", () => ({
  getSessionUserId: (...args: unknown[]) => getSessionUserId(...args),
}));

import { requireUserId } from "@/lib/route-auth";

beforeEach(() => {
  getSessionUserId.mockReset();
  cookieValue = undefined;
});

describe("requireUserId", () => {
  it("passes the session cookie value to getSessionUserId and returns its result", async () => {
    cookieValue = "sid-123";
    getSessionUserId.mockResolvedValue("user-1");
    expect(await requireUserId()).toBe("user-1");
    expect(getSessionUserId).toHaveBeenCalledWith("sid-123");
  });

  it("returns null (via getSessionUserId) when there is no cookie", async () => {
    cookieValue = undefined;
    getSessionUserId.mockResolvedValue(null);
    expect(await requireUserId()).toBeNull();
    expect(getSessionUserId).toHaveBeenCalledWith(undefined);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/route-auth.test.ts`
Expected: FAIL — cannot resolve `@/lib/route-auth`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/route-auth.ts`:

```ts
import { cookies } from "next/headers";
import { getSessionUserId } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session-cookie";

/** Resolve the logged-in user id from the session cookie (login gate; no vault check). */
export async function requireUserId(): Promise<string | null> {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  return getSessionUserId(sid);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/route-auth.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/route-auth.ts src/lib/route-auth.test.ts
git commit -m "feat: add requireUserId route auth helper (login gate)"
```

---

### Task 4: Persistence route (`api/obituary/route.ts`)

**Files:**
- Create: `src/app/api/obituary/route.ts`
- Test: `src/app/api/obituary/route.test.ts`

**Interfaces:**
- Consumes: `requireUserId` from `@/lib/route-auth`, `prisma` from `@/lib/db`, `readJsonBody` from `@/lib/http`, `ObituaryIntake` from `@/lib/obituary`, `Prisma` from `@prisma/client`.
- Produces: `GET()` → `{ obituary: { intake, draft } | null }` or 401; `PUT(req)` → `{ ok: true }`, or 400/401.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/obituary/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUserId = vi.fn();
const findUnique = vi.fn();
const upsert = vi.fn();

vi.mock("@/lib/route-auth", () => ({
  requireUserId: (...a: unknown[]) => requireUserId(...a),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    obituary: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      upsert: (...a: unknown[]) => upsert(...a),
    },
  },
}));

import { GET, PUT } from "@/app/api/obituary/route";

const intake = {
  subjectName: "Jane Doe",
  dateOfBirth: "",
  dateOfDeath: "",
  placeOrHometown: "",
  lifeStory: "A good life.",
  family: "",
  achievements: "",
  hobbies: "",
  tone: "Warm",
  length: "Standard",
  additionalWishes: "",
};

function putReq(body: unknown) {
  return new Request("http://localhost/api/obituary", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  requireUserId.mockReset();
  findUnique.mockReset();
  upsert.mockReset();
});

describe("obituary persistence route", () => {
  it("GET returns 401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("GET returns the saved obituary under `obituary`", async () => {
    requireUserId.mockResolvedValue("user-1");
    findUnique.mockResolvedValue({ intake, draft: "Saved text." });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      obituary: { intake, draft: "Saved text." },
    });
  });

  it("GET returns { obituary: null } when none saved", async () => {
    requireUserId.mockResolvedValue("user-1");
    findUnique.mockResolvedValue(null);
    expect(await (await GET()).json()).toEqual({ obituary: null });
  });

  it("PUT returns 401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await PUT(putReq({ intake, draft: "x" }))).status).toBe(401);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("PUT returns 400 when subjectName or draft is empty", async () => {
    requireUserId.mockResolvedValue("user-1");
    expect(
      (await PUT(putReq({ intake: { ...intake, subjectName: "" }, draft: "x" })))
        .status,
    ).toBe(400);
    expect((await PUT(putReq({ intake, draft: "" }))).status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("PUT upserts and returns ok", async () => {
    requireUserId.mockResolvedValue("user-1");
    upsert.mockResolvedValue({ id: "o1" });
    const res = await PUT(putReq({ intake, draft: "Saved text." }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(upsert).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      create: { userId: "user-1", intake, draft: "Saved text." },
      update: { intake, draft: "Saved text." },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/api/obituary/route.test.ts`
Expected: FAIL — cannot resolve `@/app/api/obituary/route`.

- [ ] **Step 3: Write the implementation**

Create `src/app/api/obituary/route.ts`:

```ts
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/route-auth";
import { readJsonBody } from "@/lib/http";
import { type ObituaryIntake } from "@/lib/obituary";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const row = await prisma.obituary.findUnique({
    where: { userId },
    select: { intake: true, draft: true },
  });
  return NextResponse.json({ obituary: row });
}

export async function PUT(req: Request) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;

  const intake = body.intake as ObituaryIntake | undefined;
  const draft = typeof body.draft === "string" ? body.draft : "";
  if (
    !intake ||
    typeof intake.subjectName !== "string" ||
    !intake.subjectName.trim() ||
    !draft.trim()
  ) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }

  await prisma.obituary.upsert({
    where: { userId },
    create: { userId, intake: intake as unknown as Prisma.InputJsonValue, draft },
    update: { intake: intake as unknown as Prisma.InputJsonValue, draft },
  });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app/api/obituary/route.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/obituary/route.ts src/app/api/obituary/route.test.ts
git commit -m "feat: add obituary GET/PUT persistence route (plaintext, login-gated)"
```

---

### Task 5: AI deps + generate route (`api/obituary/generate/route.ts`)

**Files:**
- Modify: `package.json` (add `ai`, `@ai-sdk/anthropic`)
- Create: `src/app/api/obituary/generate/route.ts`
- Test: `src/app/api/obituary/generate/route.test.ts`

**Interfaces:**
- Consumes: `requireUserId` from `@/lib/route-auth`, `readJsonBody` from `@/lib/http`, `buildObituaryPrompt`/`ObituaryIntake` from `@/lib/obituary`, `streamText` from `ai`, `anthropic` from `@ai-sdk/anthropic`.
- Produces: `POST(req)` → streaming text Response (200), or 400/401/500; `MODEL_ID` constant.

- [ ] **Step 1: Install the AI SDK dependencies**

Run: `npm install ai @ai-sdk/anthropic`
Expected: both packages added to `package.json` dependencies; `npm` completes without errors.

- [ ] **Step 2: Write the failing test**

Create `src/app/api/obituary/generate/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUserId = vi.fn();
const streamText = vi.fn();
const anthropic = vi.fn(() => "mock-model");

vi.mock("@/lib/route-auth", () => ({
  requireUserId: (...a: unknown[]) => requireUserId(...a),
}));
vi.mock("ai", () => ({
  streamText: (...a: unknown[]) => streamText(...a),
}));
vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: (...a: unknown[]) => anthropic(...a),
}));

import { POST, MODEL_ID } from "@/app/api/obituary/generate/route";

const intake = {
  subjectName: "Jane Doe",
  dateOfBirth: "",
  dateOfDeath: "",
  placeOrHometown: "",
  lifeStory: "A good life.",
  family: "",
  achievements: "",
  hobbies: "",
  tone: "Warm",
  length: "Standard",
  additionalWishes: "",
};

function postReq(body: unknown) {
  return new Request("http://localhost/api/obituary/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  requireUserId.mockReset();
  streamText.mockReset();
  anthropic.mockClear();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe("obituary generate route", () => {
  it("returns 401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await POST(postReq(intake))).status).toBe(401);
    expect(streamText).not.toHaveBeenCalled();
  });

  it("returns 400 when subjectName is missing", async () => {
    requireUserId.mockResolvedValue("user-1");
    expect(
      (await POST(postReq({ ...intake, subjectName: "  " }))).status,
    ).toBe(400);
    expect(streamText).not.toHaveBeenCalled();
  });

  it("returns 500 when the API key is not configured", async () => {
    requireUserId.mockResolvedValue("user-1");
    delete process.env.ANTHROPIC_API_KEY;
    expect((await POST(postReq(intake))).status).toBe(500);
    expect(streamText).not.toHaveBeenCalled();
  });

  it("streams a draft from the built prompt when authenticated", async () => {
    requireUserId.mockResolvedValue("user-1");
    streamText.mockReturnValue({
      toTextStreamResponse: () => new Response("Jane Doe lived well."),
    });
    const res = await POST(postReq(intake));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Jane Doe lived well.");
    expect(anthropic).toHaveBeenCalledWith(MODEL_ID);
    const arg = streamText.mock.calls[0][0] as {
      model: unknown;
      system: string;
      prompt: string;
    };
    expect(arg.model).toBe("mock-model");
    expect(arg.system.toLowerCase()).toContain("warm");
    expect(arg.prompt).toContain("Name: Jane Doe");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/app/api/obituary/generate/route.test.ts`
Expected: FAIL — cannot resolve `@/app/api/obituary/generate/route`.

- [ ] **Step 4: Write the implementation**

> Before writing, verify against the installed AI SDK (v6) that `streamText({ model, system, prompt })` and `result.toTextStreamResponse()` are correct for this version (per Global Constraints). Adjust the two call shapes if the installed version differs; keep the auth/validation/guard logic as written.

Create `src/app/api/obituary/generate/route.ts`:

```ts
import { NextResponse } from "next/server";
import { streamText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { requireUserId } from "@/lib/route-auth";
import { readJsonBody } from "@/lib/http";
import { buildObituaryPrompt, type ObituaryIntake } from "@/lib/obituary";

export const MODEL_ID = "claude-opus-4-8";

export async function POST(req: Request) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const intake = body as unknown as ObituaryIntake;
  if (typeof intake.subjectName !== "string" || !intake.subjectName.trim()) {
    return NextResponse.json({ error: "A name is required." }, { status: 400 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "The obituary generator is not configured." },
      { status: 500 },
    );
  }

  const { system, prompt } = buildObituaryPrompt(intake);
  const result = streamText({ model: anthropic(MODEL_ID), system, prompt });
  return result.toTextStreamResponse();
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/app/api/obituary/generate/route.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Add the env var locally**

Add `ANTHROPIC_API_KEY=<your key>` to `.env` (do not commit secrets). Confirm `.env` is gitignored.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/app/api/obituary/generate/route.ts src/app/api/obituary/generate/route.test.ts
git commit -m "feat: add streaming obituary generate route (Vercel AI SDK + Anthropic)"
```

---

### Task 6: Page, api-client methods, and nav link

**Files:**
- Modify: `src/lib/api-client.ts` (add `getObituary`, `saveObituary`)
- Create: `src/app/obituary/page.tsx`
- Modify: `src/components/AppNav.tsx` (add Obituary link)

**Interfaces:**
- Consumes: `api.getObituary`/`api.saveObituary`, `ObituaryIntake`/`ObituaryTone`/`ObituaryLength` from `@/lib/obituary`, `AppNav`, `LegacyMark`.
- Produces: the `/obituary` page and nav entry. (Verified by typecheck + build + manual run — pages are not unit-tested in this repo.)

- [ ] **Step 1: Add api-client methods**

In `src/lib/api-client.ts`, add this import at the top:

```ts
import { type ObituaryIntake } from "@/lib/obituary";
```

Then add these two methods inside the `api` object (after `addRecord`):

```ts
  getObituary: async () => {
    const res = await fetch("/api/obituary");
    if (res.status === 401) return null;
    if (!res.ok) throw new Error("We couldn't load your obituary.");
    return res.json() as Promise<{
      obituary: { intake: ObituaryIntake; draft: string } | null;
    }>;
  },
  saveObituary: async (intake: ObituaryIntake, draft: string) => {
    const res = await fetch("/api/obituary", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intake, draft }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `Request failed (${res.status})`);
    }
    return res.json() as Promise<{ ok: true }>;
  },
```

- [ ] **Step 2: Add the nav link**

In `src/components/AppNav.tsx`, add inside `<div className="navlinks">` after the Beneficiaries link:

```tsx
        <Link href="/obituary">Obituary</Link>
```

- [ ] **Step 3: Create the page**

Create `src/app/obituary/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { api } from "@/lib/api-client";
import {
  type ObituaryIntake,
  type ObituaryTone,
  type ObituaryLength,
} from "@/lib/obituary";

const TONES: ObituaryTone[] = [
  "Traditional",
  "Warm",
  "Celebratory",
  "Faith-based",
];
const LENGTHS: ObituaryLength[] = ["Short", "Standard", "Long"];

const EMPTY: ObituaryIntake = {
  subjectName: "",
  dateOfBirth: "",
  dateOfDeath: "",
  placeOrHometown: "",
  lifeStory: "",
  family: "",
  achievements: "",
  hobbies: "",
  tone: "Warm",
  length: "Standard",
  additionalWishes: "",
};

export default function ObituaryPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [intake, setIntake] = useState<ObituaryIntake>(EMPTY);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .getObituary()
      .then((data) => {
        if (!active) return;
        if (data === null) {
          router.replace("/unlock");
          return;
        }
        if (data.obituary) {
          setIntake(data.obituary.intake);
          setDraft(data.obituary.draft);
        }
        setReady(true);
      })
      .catch(() => {
        if (active) setError("We couldn't load your obituary.");
      });
    return () => {
      active = false;
    };
  }, [router]);

  function set<K extends keyof ObituaryIntake>(
    key: K,
    value: ObituaryIntake[K],
  ) {
    setIntake((it) => ({ ...it, [key]: value }));
    setSaved(false);
  }

  async function onGenerate() {
    if (!intake.subjectName.trim()) {
      setError("Please enter a name first.");
      return;
    }
    setError(null);
    setSaved(false);
    setGenerating(true);
    try {
      const res = await fetch("/api/obituary/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(intake),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Generation failed. Please try again.");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      setDraft("");
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setDraft((d) => d + chunk);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed.");
    } finally {
      setGenerating(false);
    }
  }

  async function onSave() {
    if (!intake.subjectName.trim() || !draft.trim()) {
      setError("Add a name and generate a draft before saving.");
      return;
    }
    setError(null);
    try {
      await api.saveObituary(intake, draft);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "We couldn't save your obituary.");
    }
  }

  if (!ready) return null;

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Obituary</h1>
        <p className="subtle">
          This obituary is saved as ordinary text so it can be shared — it is{" "}
          <strong>not</strong> stored in your encrypted vault.
        </p>

        <label htmlFor="subjectName">Name</label>
        <input
          id="subjectName"
          value={intake.subjectName}
          onChange={(e) => set("subjectName", e.target.value)}
        />

        <label htmlFor="dateOfBirth">Date of birth</label>
        <input
          id="dateOfBirth"
          value={intake.dateOfBirth}
          onChange={(e) => set("dateOfBirth", e.target.value)}
        />

        <label htmlFor="dateOfDeath">Date of death</label>
        <input
          id="dateOfDeath"
          value={intake.dateOfDeath}
          onChange={(e) => set("dateOfDeath", e.target.value)}
        />

        <label htmlFor="placeOrHometown">Place / hometown</label>
        <input
          id="placeOrHometown"
          value={intake.placeOrHometown}
          onChange={(e) => set("placeOrHometown", e.target.value)}
        />

        <label htmlFor="lifeStory">Life story</label>
        <textarea
          id="lifeStory"
          value={intake.lifeStory}
          onChange={(e) => set("lifeStory", e.target.value)}
        />

        <label htmlFor="family">Family (survived by)</label>
        <textarea
          id="family"
          value={intake.family}
          onChange={(e) => set("family", e.target.value)}
        />

        <label htmlFor="achievements">Achievements</label>
        <textarea
          id="achievements"
          value={intake.achievements}
          onChange={(e) => set("achievements", e.target.value)}
        />

        <label htmlFor="hobbies">Hobbies and interests</label>
        <textarea
          id="hobbies"
          value={intake.hobbies}
          onChange={(e) => set("hobbies", e.target.value)}
        />

        <label htmlFor="tone">Tone</label>
        <select
          id="tone"
          value={intake.tone}
          onChange={(e) => set("tone", e.target.value as ObituaryTone)}
        >
          {TONES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <label htmlFor="length">Length</label>
        <select
          id="length"
          value={intake.length}
          onChange={(e) => set("length", e.target.value as ObituaryLength)}
        >
          {LENGTHS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>

        <label htmlFor="additionalWishes">Anything else</label>
        <textarea
          id="additionalWishes"
          value={intake.additionalWishes}
          onChange={(e) => set("additionalWishes", e.target.value)}
        />

        <button type="button" onClick={onGenerate} disabled={generating}>
          {generating ? "Generating…" : draft ? "Regenerate" : "Generate"}
        </button>

        {error && <p className="error">{error}</p>}

        <label htmlFor="draft">Draft</label>
        <textarea
          id="draft"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setSaved(false);
          }}
          rows={14}
        />

        <button type="button" onClick={onSave} disabled={generating}>
          Save
        </button>
        {saved && <p className="subtle">Saved.</p>}
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 5: Run the full unit suite**

Run: `npm test`
Expected: PASS — all existing tests plus the new `obituary`, `route-auth`, and both route test files.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: build succeeds; `/obituary`, `/api/obituary`, and `/api/obituary/generate` appear in the route output.

- [ ] **Step 7: Manual smoke test**

With `ANTHROPIC_API_KEY` set in `.env`, run `npm run dev`, log in, open `/obituary`. Verify: the non-vault banner shows; filling a name + life story and clicking Generate streams a draft into the editor; editing then Save shows "Saved."; reloading the page rehydrates the saved intake + draft. (If `/api/*` returns 404 under Turbopack, stop dev, delete `.next`, restart — see `AGENTS.md` Gotchas.)

- [ ] **Step 8: Commit**

```bash
git add src/lib/api-client.ts src/app/obituary/page.tsx src/components/AppNav.tsx
git commit -m "feat: add obituary page, api-client methods, and nav link"
```

---

## Self-Review

**Spec coverage:**
- Non-vault/plaintext decision → Task 2 (plaintext model), Global Constraints, page banner (Task 6). ✓
- Login-only, not vault unlock → Task 3 (`requireUserId`), page redirect to `/unlock` (Task 6). ✓
- Domain lib + pure `buildObituaryPrompt` → Task 1. ✓
- `Obituary` model (one per user, JSON intake) + migration on both DBs → Task 2. ✓
- Generate route (streaming, AI SDK, model constant, no persistence) → Task 5. ✓
- Persistence GET/PUT (upsert, overwrite) → Task 4. ✓
- Page (form + streamed editor, generate/regenerate/save, banner) → Task 6. ✓
- Nav link → Task 6. ✓
- Error handling (AI failure, missing key, validation) → Tasks 4/5/6. ✓
- Testing (unit lib, route tests with mocked model, gates) → Tasks 1/3/4/5/6. ✓
- Out of scope (survivor infra, multiple drafts, prefill, export, live e2e) → not implemented, by design. ✓

**Type consistency:** `ObituaryIntake`/`ObituaryTone`/`ObituaryLength`, `buildObituaryPrompt`→`{system,prompt}`, `requireUserId`, `serializeIntake`/`parseIntake`, `MODEL_ID`, and the `{ obituary: {intake,draft} | null }` GET shape are used identically across tasks. ✓

**Placeholders:** none — every code/test step shows full content. ✓
