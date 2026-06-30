import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUserId = vi.fn();
const findFirst = vi.fn();
const deleteMany = vi.fn();

vi.mock("@/lib/route-auth", () => ({ requireUserId: () => requireUserId() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    document: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      deleteMany: (...a: unknown[]) => deleteMany(...a),
    },
  },
}));

import { GET, DELETE } from "./route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://localhost/api/documents/d1");

beforeEach(() => {
  requireUserId.mockReset();
  findFirst.mockReset();
  deleteMany.mockReset();
});

describe("/api/documents/[id]", () => {
  it("GET 401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await GET(req(), ctx("d1"))).status).toBe(401);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("GET 404 when the document is not the user's", async () => {
    requireUserId.mockResolvedValue("u1");
    findFirst.mockResolvedValue(null);
    expect((await GET(req(), ctx("d1"))).status).toBe(404);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "d1", userId: "u1" },
      select: { contentCiphertext: true, contentIv: true },
    });
  });

  it("GET returns the content blob", async () => {
    requireUserId.mockResolvedValue("u1");
    findFirst.mockResolvedValue({ contentCiphertext: "cc", contentIv: "ci" });
    const res = await GET(req(), ctx("d1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ contentCiphertext: "cc", contentIv: "ci" });
  });

  it("DELETE 401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await DELETE(req(), ctx("d1"))).status).toBe(401);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("DELETE 404 when nothing was deleted", async () => {
    requireUserId.mockResolvedValue("u1");
    deleteMany.mockResolvedValue({ count: 0 });
    expect((await DELETE(req(), ctx("d1"))).status).toBe(404);
  });

  it("DELETE 200 when a row is removed", async () => {
    requireUserId.mockResolvedValue("u1");
    deleteMany.mockResolvedValue({ count: 1 });
    const res = await DELETE(req(), ctx("d1"));
    expect(res.status).toBe(200);
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "d1", userId: "u1" } });
  });
});
