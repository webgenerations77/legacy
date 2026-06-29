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
