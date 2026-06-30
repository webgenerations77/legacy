import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const findFirst = vi.fn();
const verifyVerifier = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: (...a: unknown[]) => findUnique(...a) },
    document: { findFirst: (...a: unknown[]) => findFirst(...a) },
  },
}));
vi.mock("@/lib/auth", () => ({ verifyVerifier: (...a: unknown[]) => verifyVerifier(...a) }));

import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://localhost/api/survivor/document", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ok = { email: "a@b.com", survivorAuthVerifier: "v", documentId: "d1" };
const userRow = { id: "u1", survivorAccess: { survivorAuthVerifierHash: "hash" } };

beforeEach(() => {
  findUnique.mockReset();
  findFirst.mockReset();
  verifyVerifier.mockReset();
});

describe("/api/survivor/document", () => {
  it("401 generic when fields are missing", async () => {
    const res = await POST(req({ email: "a@b.com" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Could not unlock." });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("401 when no survivor access", async () => {
    findUnique.mockResolvedValue(null);
    expect((await POST(req(ok))).status).toBe(401);
  });

  it("401 when the verifier does not match", async () => {
    findUnique.mockResolvedValue(userRow);
    verifyVerifier.mockResolvedValue(false);
    expect((await POST(req(ok))).status).toBe(401);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("401 (not 404) when the document is unknown", async () => {
    findUnique.mockResolvedValue(userRow);
    verifyVerifier.mockResolvedValue(true);
    findFirst.mockResolvedValue(null);
    const res = await POST(req(ok));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Could not unlock." });
  });

  it("returns the content blob on a correct verifier + owned doc", async () => {
    findUnique.mockResolvedValue(userRow);
    verifyVerifier.mockResolvedValue(true);
    findFirst.mockResolvedValue({ contentCiphertext: "cc", contentIv: "ci" });
    const res = await POST(req(ok));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ contentCiphertext: "cc", contentIv: "ci" });
    expect(verifyVerifier).toHaveBeenCalledWith("v", "hash");
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "d1", userId: "u1" },
      select: { contentCiphertext: true, contentIv: true },
    });
  });
});
