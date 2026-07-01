import { describe, it, expect, vi, beforeEach } from "vitest";

const accessFindFirst = vi.fn();
const userFindUnique = vi.fn();
const verifyVerifier = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    survivorAccess: { findFirst: (...a: unknown[]) => accessFindFirst(...a) },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
  },
}));
vi.mock("@/lib/auth", () => ({
  verifyVerifier: (...a: unknown[]) => verifyVerifier(...a),
  DECOY_VERIFIER_HASH: "decoy-hash",
}));

import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://localhost/api/survivor/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const accessRow = { userId: "u1", escrowCiphertext: "EC", escrowIv: "EI", survivorAuthVerifierHash: "hash" };
const vaultRow = {
  vaultItems: [{ id: "v1", ciphertext: "vc", iv: "vi" }],
  financialAccounts: [{ id: "a1", ciphertext: "ac", iv: "ai" }],
  bills: [],
  loans: [],
  beneficiaries: [],
  documents: [{ id: "d1", metaCiphertext: "dmc", metaIv: "dmi", createdAt: new Date(0) }],
  obituary: { intake: { subjectName: "X" }, draft: "An obituary" },
};

beforeEach(() => {
  accessFindFirst.mockReset();
  userFindUnique.mockReset();
  verifyVerifier.mockReset();
});

describe("/api/survivor/claim", () => {
  it("401 + decoy verify when the verifier is empty (no DB hit)", async () => {
    const res = await POST(req({ email: "a@b.com", survivorAuthVerifier: "" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Could not unlock." });
    expect(accessFindFirst).not.toHaveBeenCalled();
    expect(verifyVerifier).toHaveBeenCalledWith("", "decoy-hash");
  });

  it("401 with generic body when body is malformed JSON", async () => {
    const malformed = new Request("http://localhost/api/survivor/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(malformed);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Could not unlock." });
  });

  it("runs a decoy verify (parity) and denies when the account is not armed", async () => {
    accessFindFirst.mockResolvedValue(null);
    verifyVerifier.mockResolvedValue(false);
    const res = await POST(req({ email: "ghost@b.com", survivorAuthVerifier: "v" }));
    expect(res.status).toBe(401);
    expect(verifyVerifier).toHaveBeenCalledWith("v", "decoy-hash");
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("401 when the verifier does not match (vault never loaded)", async () => {
    accessFindFirst.mockResolvedValue(accessRow);
    verifyVerifier.mockResolvedValue(false);
    const res = await POST(req({ email: "a@b.com", survivorAuthVerifier: "wrong" }));
    expect(res.status).toBe(401);
    expect(verifyVerifier).toHaveBeenCalledWith("wrong", "hash");
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("returns escrow + all records + no-store on a correct verifier", async () => {
    accessFindFirst.mockResolvedValue(accessRow);
    verifyVerifier.mockResolvedValue(true);
    userFindUnique.mockResolvedValue(vaultRow);
    const res = await POST(req({ email: "a@b.com", survivorAuthVerifier: "right" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = await res.json();
    expect(data.escrow).toEqual({ ciphertext: "EC", iv: "EI" });
    expect(data.records).toEqual({
      items: [{ id: "v1", ciphertext: "vc", iv: "vi" }],
      accounts: [{ id: "a1", ciphertext: "ac", iv: "ai" }],
      bills: [],
      loans: [],
      beneficiaries: [],
      documents: [{ id: "d1", metaCiphertext: "dmc", metaIv: "dmi", createdAt: new Date(0).toISOString() }],
      obituary: { intake: { subjectName: "X" }, draft: "An obituary" },
    });
    expect(verifyVerifier).toHaveBeenCalledWith("right", "hash");
  });
});
