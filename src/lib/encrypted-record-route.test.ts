import { describe, it, expect, vi, beforeEach } from "vitest";

const getSessionUserId = vi.fn();
const findMany = vi.fn();
const create = vi.fn();

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "sid-123" }) }),
}));
vi.mock("@/lib/auth", () => ({
  getSessionUserId: (...args: unknown[]) => getSessionUserId(...args),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    bill: {
      findMany: (...a: unknown[]) => findMany(...a),
      create: (...a: unknown[]) => create(...a),
    },
  },
}));

import { createEncryptedRecordRoute } from "@/lib/encrypted-record-route";

const { GET, POST } = createEncryptedRecordRoute({ model: "bill", listKey: "bills" });

function postReq(body: unknown) {
  return new Request("http://localhost/api/bills", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getSessionUserId.mockReset();
  findMany.mockReset();
  create.mockReset();
});

describe("createEncryptedRecordRoute", () => {
  it("GET returns 401 when unauthenticated", async () => {
    getSessionUserId.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("GET lists rows under the configured key when authenticated", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    findMany.mockResolvedValue([{ id: "b1", ciphertext: "c", iv: "i" }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bills: [{ id: "b1", ciphertext: "c", iv: "i" }] });
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { createdAt: "desc" },
      select: { id: true, ciphertext: true, iv: true },
    });
  });

  it("POST returns 401 when unauthenticated", async () => {
    getSessionUserId.mockResolvedValue(null);
    const res = await POST(postReq({ ciphertext: "c", iv: "i" }));
    expect(res.status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it("POST returns 400 when fields are missing or non-string", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    expect((await POST(postReq({ ciphertext: "c" }))).status).toBe(400);
    expect((await POST(postReq({ ciphertext: 123, iv: "i" }))).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("POST creates and returns 201 with the new id", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    create.mockResolvedValue({ id: "new-id" });
    const res = await POST(postReq({ ciphertext: "c", iv: "i" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "new-id" });
    expect(create).toHaveBeenCalledWith({
      data: { userId: "user-1", ciphertext: "c", iv: "i" },
      select: { id: true },
    });
  });
});
