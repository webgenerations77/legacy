import { describe, it, expect, vi, beforeEach } from "vitest";

const accessFindFirst = vi.fn();
const docFindFirst = vi.fn();
const verifyVerifier = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    survivorAccess: { findFirst: (...a: unknown[]) => accessFindFirst(...a) },
    document: { findFirst: (...a: unknown[]) => docFindFirst(...a) },
  },
}));
vi.mock("@/lib/auth", () => ({
  verifyVerifier: (...a: unknown[]) => verifyVerifier(...a),
  DECOY_VERIFIER_HASH: "decoy-hash",
}));

import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://localhost/api/survivor/document", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ok = { email: "a@b.com", survivorAuthVerifier: "v", documentId: "d1" };
const accessRow = { userId: "u1", survivorAuthVerifierHash: "hash" };

beforeEach(() => {
  accessFindFirst.mockReset();
  docFindFirst.mockReset();
  verifyVerifier.mockReset();
});

describe("/api/survivor/document", () => {
  it("401 + decoy verify when fields are missing (no DB hit)", async () => {
    const res = await POST(req({ email: "a@b.com", survivorAuthVerifier: "v" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Could not unlock." });
    expect(accessFindFirst).not.toHaveBeenCalled();
    expect(verifyVerifier).toHaveBeenCalledWith("v", "decoy-hash");
    expect(verifyVerifier).toHaveBeenCalledTimes(1);
  });

  it("runs a decoy verify (parity) and denies when no survivor access", async () => {
    accessFindFirst.mockResolvedValue(null);
    verifyVerifier.mockResolvedValue(false);
    expect((await POST(req(ok))).status).toBe(401);
    expect(verifyVerifier).toHaveBeenCalledWith("v", "decoy-hash");
    expect(verifyVerifier).toHaveBeenCalledTimes(1);
    expect(docFindFirst).not.toHaveBeenCalled();
  });

  it("401 when the verifier does not match (doc never queried)", async () => {
    accessFindFirst.mockResolvedValue(accessRow);
    verifyVerifier.mockResolvedValue(false);
    expect((await POST(req(ok))).status).toBe(401);
    expect(verifyVerifier).toHaveBeenCalledWith("v", "hash");
    expect(verifyVerifier).toHaveBeenCalledTimes(1);
    expect(docFindFirst).not.toHaveBeenCalled();
  });

  it("401 (not 404) when the document is unknown", async () => {
    accessFindFirst.mockResolvedValue(accessRow);
    verifyVerifier.mockResolvedValue(true);
    docFindFirst.mockResolvedValue(null);
    const res = await POST(req(ok));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Could not unlock." });
  });

  it("returns the content blob + no-store on a correct verifier + owned doc", async () => {
    accessFindFirst.mockResolvedValue(accessRow);
    verifyVerifier.mockResolvedValue(true);
    docFindFirst.mockResolvedValue({ contentCiphertext: "cc", contentIv: "ci" });
    const res = await POST(req(ok));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ contentCiphertext: "cc", contentIv: "ci" });
    expect(verifyVerifier).toHaveBeenCalledWith("v", "hash");
    expect(verifyVerifier).toHaveBeenCalledTimes(1);
    expect(docFindFirst).toHaveBeenCalledWith({
      where: { id: "d1", userId: "u1" },
      select: { contentCiphertext: true, contentIv: true },
    });
  });
});
