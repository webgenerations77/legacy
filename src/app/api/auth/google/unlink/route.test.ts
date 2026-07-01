import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUserId = vi.fn();
const findUnique = vi.fn();
const update = vi.fn();
vi.mock("@/lib/route-auth", () => ({ requireUserId: () => requireUserId() }));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a), update: (...a: unknown[]) => update(...a) } },
}));
vi.mock("@/lib/auth", () => ({ verifyVerifier: async (v: string, h: string) => h === `hash:${v}` }));

import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://localhost/api/auth/google/unlink", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  requireUserId.mockReset();
  findUnique.mockReset();
  update.mockReset();
});

describe("POST /api/auth/google/unlink", () => {
  it("401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await POST(req({ authVerifier: "v" }))).status).toBe(401);
  });

  it("clears googleId on correct passphrase", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ id: "u1", authVerifierHash: "hash:v", googleId: "g1" });
    update.mockResolvedValue({});
    const res = await POST(req({ authVerifier: "v" }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { googleId: null } });
  });

  it("401 on wrong passphrase", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ id: "u1", authVerifierHash: "hash:right", googleId: "g1" });
    expect((await POST(req({ authVerifier: "wrong" }))).status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it("409 when the account has no password login", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ id: "u1", authVerifierHash: null, googleId: "g1" });
    expect((await POST(req({ authVerifier: "v" }))).status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });
});
