import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUserId = vi.fn();
const findUnique = vi.fn();
vi.mock("@/lib/route-auth", () => ({ requireUserId: () => requireUserId() }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a) } } }));

import { GET } from "./route";

beforeEach(() => {
  requireUserId.mockReset();
  findUnique.mockReset();
});

describe("GET /api/auth/vault/wrapped-key", () => {
  it("401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns the wrapped key pair + no-store when set", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ wrappedKeyCiphertext: "ct", wrappedKeyIv: "iv" });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ wrappedKeyCiphertext: "ct", wrappedKeyIv: "iv" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns null when the account has no wrapped key (legacy)", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ wrappedKeyCiphertext: null, wrappedKeyIv: null });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ wrappedKeyCiphertext: null });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("401 when the user row is missing", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });
});
