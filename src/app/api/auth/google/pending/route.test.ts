import { describe, it, expect, vi, beforeEach } from "vitest";

let cookieVal: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (_: string) => (cookieVal === undefined ? undefined : { value: cookieVal }) }),
}));

process.env.LINK_STATE_SECRET = "pending-secret";
import { GET } from "./route";
import { signPendingLink } from "@/lib/link-token";

beforeEach(() => {
  cookieVal = undefined;
});

describe("GET /api/auth/google/pending", () => {
  it("returns null when no cookie", async () => {
    expect(await (await GET()).json()).toEqual({ email: null });
  });

  it("returns the email from a valid cookie", async () => {
    cookieVal = signPendingLink({ googleId: "g1", email: "a@example.com" }, "pending-secret");
    expect(await (await GET()).json()).toEqual({ email: "a@example.com" });
  });

  it("returns null for a tampered cookie", async () => {
    cookieVal = "garbage.value";
    expect(await (await GET()).json()).toEqual({ email: null });
  });
});
