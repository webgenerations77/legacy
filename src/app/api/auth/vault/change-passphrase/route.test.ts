import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUserId = vi.fn();
const findUnique = vi.fn();
const update = vi.fn();
vi.mock("@/lib/route-auth", () => ({ requireUserId: () => requireUserId() }));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a), update: (...a: unknown[]) => update(...a) } },
}));
vi.mock("@/lib/auth", () => ({
  verifyVerifier: async (v: string, h: string) => h === `hash:${v}`,
  hashVerifier: async (v: string) => `hash:${v}`,
}));

import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://localhost/api/auth/vault/change-passphrase", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const good = {
  currentAuthVerifier: "cur",
  kdfSalt: "newsalt",
  wrappedKeyCiphertext: "wct",
  wrappedKeyIv: "wiv",
  authVerifier: "newver",
};

beforeEach(() => {
  requireUserId.mockReset();
  findUnique.mockReset();
  update.mockReset();
});

describe("POST /api/auth/vault/change-passphrase", () => {
  it("401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await POST(req(good))).status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it("400 when a field is missing", async () => {
    requireUserId.mockResolvedValue("u1");
    const { kdfSalt, ...missing } = good;
    void kdfSalt;
    expect((await POST(req(missing))).status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("401 on wrong current passphrase (no update)", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ authVerifierHash: "hash:right" });
    expect((await POST(req({ ...good, currentAuthVerifier: "wrong" }))).status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it("401 when the account has no passphrase set", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ authVerifierHash: null });
    expect((await POST(req(good))).status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it("atomically updates all four fields on correct current passphrase", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ authVerifierHash: "hash:cur" });
    update.mockResolvedValue({});
    const res = await POST(req(good));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: {
        kdfSalt: "newsalt",
        wrappedKeyCiphertext: "wct",
        wrappedKeyIv: "wiv",
        authVerifierHash: "hash:newver",
      },
    });
  });
});
