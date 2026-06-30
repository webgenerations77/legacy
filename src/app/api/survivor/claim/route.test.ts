import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const verifyVerifier = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));
vi.mock("@/lib/auth", () => ({
  verifyVerifier: (...a: unknown[]) => verifyVerifier(...a),
}));

import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://localhost/api/survivor/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const userRow = {
  survivorAccess: {
    survivorAuthVerifierHash: "hash",
    escrowCiphertext: "EC",
    escrowIv: "EI",
  },
  vaultItems: [{ id: "v1", ciphertext: "vc", iv: "vi" }],
  financialAccounts: [{ id: "a1", ciphertext: "ac", iv: "ai" }],
  bills: [],
  loans: [],
  beneficiaries: [],
  obituary: { intake: { subjectName: "X" }, draft: "An obituary" },
};

beforeEach(() => {
  findUnique.mockReset();
  verifyVerifier.mockReset();
});

describe("/api/survivor/claim", () => {
  it("401 when no survivor access for that email", async () => {
    findUnique.mockResolvedValue(null);
    const res = await POST(req({ email: "a@b.com", survivorAuthVerifier: "v" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Could not unlock." });
  });

  it("401 with generic body when fields are missing or empty", async () => {
    const cases = [
      req({}),
      req({ email: "", survivorAuthVerifier: "x" }),
    ];
    for (const r of cases) {
      const res = await POST(r);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Could not unlock." });
    }
    expect(findUnique).not.toHaveBeenCalled();
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

  it("401 when the verifier does not match", async () => {
    findUnique.mockResolvedValue(userRow);
    verifyVerifier.mockResolvedValue(false);
    const res = await POST(req({ email: "a@b.com", survivorAuthVerifier: "wrong" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Could not unlock." });
  });

  it("returns escrow + all records on a correct verifier", async () => {
    findUnique.mockResolvedValue(userRow);
    verifyVerifier.mockResolvedValue(true);
    const res = await POST(req({ email: "a@b.com", survivorAuthVerifier: "right" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      escrow: { ciphertext: "EC", iv: "EI" },
      records: {
        items: [{ id: "v1", ciphertext: "vc", iv: "vi" }],
        accounts: [{ id: "a1", ciphertext: "ac", iv: "ai" }],
        bills: [],
        loans: [],
        beneficiaries: [],
        obituary: { intake: { subjectName: "X" }, draft: "An obituary" },
      },
    });
    expect(verifyVerifier).toHaveBeenCalledWith("right", "hash");
  });
});
