import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

import { POST } from "./route";
import { decoySalt } from "@/lib/survivor";

process.env.SURVIVOR_SALT_SECRET = "test-secret";

function req(body: unknown) {
  return new Request("http://localhost/api/survivor/salt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => findUnique.mockReset());

describe("/api/survivor/salt", () => {
  it("returns the real salt when armed", async () => {
    findUnique.mockResolvedValue({ survivorAccess: { survivorSalt: "REAL_SALT" } });
    const res = await POST(req({ email: "a@example.com" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ salt: "REAL_SALT" });
  });

  it("returns a deterministic decoy salt (not 404) when unarmed", async () => {
    findUnique.mockResolvedValue({ survivorAccess: null });
    const res = await POST(req({ email: "a@example.com" }));
    expect(res.status).toBe(200);
    expect((await res.json()).salt).toBe(await decoySalt("test-secret", "a@example.com"));
  });

  it("returns a decoy for an unknown user too", async () => {
    findUnique.mockResolvedValue(null);
    const res = await POST(req({ email: "ghost@example.com" }));
    expect(res.status).toBe(200);
    expect((await res.json()).salt).toBe(await decoySalt("test-secret", "ghost@example.com"));
  });
});
