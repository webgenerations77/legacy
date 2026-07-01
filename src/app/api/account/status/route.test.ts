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

describe("GET /api/account/status", () => {
  it("401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("401 when the user row is missing", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("reports linked + hasPassword flags", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ email: "a@example.com", googleId: "g1", authVerifierHash: "$2..." });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "a@example.com", googleLinked: true, hasPassword: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("reports not-linked + no-password when nulls", async () => {
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ email: "a@example.com", googleId: null, authVerifierHash: null });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "a@example.com", googleLinked: false, hasPassword: false });
  });
});
