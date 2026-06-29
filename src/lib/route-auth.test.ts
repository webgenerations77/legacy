import { describe, it, expect, vi, beforeEach } from "vitest";

const getSessionUserId = vi.fn();
let cookieValue: string | undefined;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (cookieValue === undefined ? undefined : { value: cookieValue }),
  }),
}));
vi.mock("@/lib/auth", () => ({
  getSessionUserId: (...args: unknown[]) => getSessionUserId(...args),
}));

import { requireUserId } from "@/lib/route-auth";

beforeEach(() => {
  getSessionUserId.mockReset();
  cookieValue = undefined;
});

describe("requireUserId", () => {
  it("passes the session cookie value to getSessionUserId and returns its result", async () => {
    cookieValue = "sid-123";
    getSessionUserId.mockResolvedValue("user-1");
    expect(await requireUserId()).toBe("user-1");
    expect(getSessionUserId).toHaveBeenCalledWith("sid-123");
  });

  it("returns null (via getSessionUserId) when there is no cookie", async () => {
    cookieValue = undefined;
    getSessionUserId.mockResolvedValue(null);
    expect(await requireUserId()).toBeNull();
    expect(getSessionUserId).toHaveBeenCalledWith(undefined);
  });
});
