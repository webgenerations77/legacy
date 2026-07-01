import { describe, it, expect, vi, beforeEach } from "vitest";
import { MAX_DOCUMENT_BODY } from "@/lib/document";

const requireUserId = vi.fn();
const findMany = vi.fn();
const create = vi.fn();
const queryRaw = vi.fn();

vi.mock("@/lib/route-auth", () => ({ requireUserId: () => requireUserId() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    document: {
      findMany: (...a: unknown[]) => findMany(...a),
      create: (...a: unknown[]) => create(...a),
    },
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
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
  queryRaw.mockReset();
  // default: user is well under quota
  queryRaw.mockResolvedValue([{ n: BigInt(0), bytes: BigInt(0) }]);
});

describe("/api/documents", () => {
  it("GET 401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("GET returns metadata only (no content) and no-store", async () => {
    requireUserId.mockResolvedValue("u1");
    findMany.mockResolvedValue([{ id: "d1", metaCiphertext: "mc", metaIv: "mi", createdAt: new Date(0) }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = await res.json();
    expect(data.documents[0]).toMatchObject({ id: "d1", metaCiphertext: "mc", metaIv: "mi" });
    expect(JSON.stringify(data)).not.toContain("contentCiphertext");
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

  it("POST 413 when the whole body exceeds the ceiling", async () => {
    requireUserId.mockResolvedValue("u1");
    const over = "a".repeat(MAX_DOCUMENT_BODY + 1);
    expect((await POST(postReq({ ...goodBody, contentCiphertext: over }))).status).toBe(413);
    expect(create).not.toHaveBeenCalled();
  });

  it("POST 409 when the document count is at the limit", async () => {
    requireUserId.mockResolvedValue("u1");
    queryRaw.mockResolvedValue([{ n: BigInt(50), bytes: BigInt(0) }]);
    const res = await POST(postReq(goodBody));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Document limit reached.");
    expect(create).not.toHaveBeenCalled();
  });

  it("POST 409 when adding would exceed the total-bytes limit", async () => {
    requireUserId.mockResolvedValue("u1");
    queryRaw.mockResolvedValue([{ n: BigInt(1), bytes: BigInt(100 * 1024 * 1024) }]);
    const res = await POST(postReq(goodBody));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Storage limit reached.");
    expect(create).not.toHaveBeenCalled();
  });

  it("POST creates and returns the id when under quota", async () => {
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
