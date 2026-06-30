import { describe, it, expect, vi, beforeEach } from "vitest";

const getSessionUserId = vi.fn();
const updateMany = vi.fn();
const deleteMany = vi.fn();

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "sid-123" }) }),
}));
vi.mock("@/lib/auth", () => ({
  getSessionUserId: (...a: unknown[]) => getSessionUserId(...a),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    bill: {
      updateMany: (...a: unknown[]) => updateMany(...a),
      deleteMany: (...a: unknown[]) => deleteMany(...a),
    },
  },
}));

import { createEncryptedRecordItemRoute } from "@/lib/encrypted-record-item-route";

const { PUT, DELETE } = createEncryptedRecordItemRoute({ model: "bill" });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const putReq = (body: unknown) =>
  new Request("http://localhost/api/bills/abc", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const delReq = () => new Request("http://localhost/api/bills/abc", { method: "DELETE" });

beforeEach(() => {
  getSessionUserId.mockReset();
  updateMany.mockReset();
  deleteMany.mockReset();
});

describe("createEncryptedRecordItemRoute", () => {
  it("PUT 401 when unauthenticated; delegate not called", async () => {
    getSessionUserId.mockResolvedValue(null);
    const res = await PUT(putReq({ ciphertext: "c", iv: "i" }), ctx("abc"));
    expect(res.status).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("PUT 400 when ciphertext/iv missing or non-string", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    expect((await PUT(putReq({ ciphertext: "c" }), ctx("abc"))).status).toBe(400);
    expect((await PUT(putReq({ ciphertext: 1, iv: "i" }), ctx("abc"))).status).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("PUT 404 when no row matches {id, userId}", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    updateMany.mockResolvedValue({ count: 0 });
    const res = await PUT(putReq({ ciphertext: "c", iv: "i" }), ctx("abc"));
    expect(res.status).toBe(404);
  });

  it("PUT 200 updates the owned row", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    updateMany.mockResolvedValue({ count: 1 });
    const res = await PUT(putReq({ ciphertext: "c2", iv: "i2" }), ctx("abc"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "abc", userId: "user-1" },
      data: { ciphertext: "c2", iv: "i2" },
    });
  });

  it("DELETE 401 unauth; 404 on no match; 200 on success", async () => {
    getSessionUserId.mockResolvedValue(null);
    expect((await DELETE(delReq(), ctx("abc"))).status).toBe(401);

    getSessionUserId.mockResolvedValue("user-1");
    deleteMany.mockResolvedValue({ count: 0 });
    expect((await DELETE(delReq(), ctx("abc"))).status).toBe(404);

    deleteMany.mockResolvedValue({ count: 1 });
    const ok = await DELETE(delReq(), ctx("abc"));
    expect(ok.status).toBe(200);
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "abc", userId: "user-1" } });
  });
});
