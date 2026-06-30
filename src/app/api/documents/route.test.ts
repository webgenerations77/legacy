import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUserId = vi.fn();
const findMany = vi.fn();
const create = vi.fn();

vi.mock("@/lib/route-auth", () => ({ requireUserId: () => requireUserId() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    document: {
      findMany: (...a: unknown[]) => findMany(...a),
      create: (...a: unknown[]) => create(...a),
    },
  },
}));

import { GET, POST } from "./route";

function postReq(body: unknown) {
  return new Request("http://localhost/api/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const goodBody = { metaCiphertext: "mc", metaIv: "mi", contentCiphertext: "cc", contentIv: "ci" };

beforeEach(() => {
  requireUserId.mockReset();
  findMany.mockReset();
  create.mockReset();
});

describe("/api/documents", () => {
  it("GET 401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("GET returns metadata only (no content)", async () => {
    requireUserId.mockResolvedValue("u1");
    findMany.mockResolvedValue([{ id: "d1", metaCiphertext: "mc", metaIv: "mi", createdAt: new Date(0) }]);
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.documents[0]).toMatchObject({ id: "d1", metaCiphertext: "mc", metaIv: "mi" });
    expect(JSON.stringify(data)).not.toContain("contentCiphertext");
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
      orderBy: { createdAt: "desc" },
      select: { id: true, metaCiphertext: true, metaIv: true, createdAt: true },
    });
  });

  it("POST 401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await POST(postReq(goodBody))).status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it("POST 400 when a field is missing", async () => {
    requireUserId.mockResolvedValue("u1");
    expect((await POST(postReq({ metaCiphertext: "mc" }))).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("POST 400 when content ciphertext is too large", async () => {
    requireUserId.mockResolvedValue("u1");
    const huge = "a".repeat(8 * 1024 * 1024 + 1);
    expect((await POST(postReq({ ...goodBody, contentCiphertext: huge }))).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("POST 400 when meta ciphertext is too large", async () => {
    requireUserId.mockResolvedValue("u1");
    const huge = "a".repeat(64 * 1024 + 1);
    expect((await POST(postReq({ ...goodBody, metaCiphertext: huge }))).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("POST creates and returns the id", async () => {
    requireUserId.mockResolvedValue("u1");
    create.mockResolvedValue({ id: "d9" });
    const res = await POST(postReq(goodBody));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "d9" });
    expect(create).toHaveBeenCalledWith({
      data: { userId: "u1", metaCiphertext: "mc", metaIv: "mi", contentCiphertext: "cc", contentIv: "ci" },
      select: { id: true },
    });
  });
});
