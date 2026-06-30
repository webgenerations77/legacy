import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUserId = vi.fn();
const findUnique = vi.fn();
const upsert = vi.fn();
const deleteMany = vi.fn();

vi.mock("@/lib/route-auth", () => ({ requireUserId: () => requireUserId() }));
vi.mock("@/lib/auth", () => ({ hashVerifier: async (v: string) => `hash:${v}` }));
vi.mock("@/lib/db", () => ({
  prisma: {
    survivorAccess: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      upsert: (...a: unknown[]) => upsert(...a),
      deleteMany: (...a: unknown[]) => deleteMany(...a),
    },
  },
}));

import { GET, POST, DELETE } from "./route";

function postReq(body: unknown) {
  return new Request("http://localhost/api/survivor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const armBody = {
  survivorSalt: "s",
  survivorAuthVerifier: "v",
  escrowCiphertext: "c",
  escrowIv: "i",
};

beforeEach(() => {
  requireUserId.mockReset();
  findUnique.mockReset();
  upsert.mockReset();
  deleteMany.mockReset();
});

describe("/api/survivor", () => {
  it("POST 401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await POST(postReq(armBody))).status).toBe(401);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("POST 400 when a field is missing", async () => {
    requireUserId.mockResolvedValue("u1");
    expect((await POST(postReq({ survivorSalt: "s" }))).status).toBe(400);
  });

  it("POST upserts and hashes the verifier", async () => {
    requireUserId.mockResolvedValue("u1");
    upsert.mockResolvedValue({ id: "sa1" });
    const res = await POST(postReq(armBody));
    expect(res.status).toBe(201);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1" },
        create: expect.objectContaining({ userId: "u1", survivorAuthVerifierHash: "hash:v" }),
        update: expect.objectContaining({ survivorAuthVerifierHash: "hash:v" }),
      }),
    );
  });

  it("GET reports armed state", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ updatedAt: new Date("2026-06-30T00:00:00Z") });
    expect(await (await GET()).json()).toEqual({
      armed: true,
      updatedAt: "2026-06-30T00:00:00.000Z",
    });
    findUnique.mockResolvedValue(null);
    expect(await (await GET()).json()).toEqual({ armed: false, updatedAt: null });
  });

  it("DELETE revokes", async () => {
    requireUserId.mockResolvedValue("u1");
    deleteMany.mockResolvedValue({ count: 1 });
    expect((await DELETE()).status).toBe(200);
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });
});
