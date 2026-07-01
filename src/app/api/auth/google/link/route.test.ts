import { describe, it, expect, vi, beforeEach } from "vitest";

let cookieVal: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (_: string) => (cookieVal === undefined ? undefined : { value: cookieVal }) }),
}));

const requireUserId = vi.fn();
vi.mock("@/lib/route-auth", () => ({ requireUserId: () => requireUserId() }));

const findUnique = vi.fn();
const update = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a), update: (...a: unknown[]) => update(...a) } },
}));

vi.mock("@/lib/auth", () => ({
  verifyVerifier: async (v: string, h: string) => h === `hash:${v}`,
  createSession: async () => "sess-new",
  DECOY_VERIFIER_HASH: "hash:__decoy__",
}));

process.env.LINK_STATE_SECRET = "link-secret";
import { POST } from "./route";
import { signPendingLink, PENDING_LINK_COOKIE } from "@/lib/link-token";

function req(body: unknown) {
  return new Request("http://localhost/api/auth/google/link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function setCookie(res: Response, name: string): string | undefined {
  return (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith(`${name}=`))?.split(";")[0].split("=")[1];
}
const validCookie = () => signPendingLink({ googleId: "g-new", email: "a@example.com" }, "link-secret");

beforeEach(() => {
  cookieVal = undefined;
  requireUserId.mockReset();
  findUnique.mockReset();
  update.mockReset();
});

describe("POST /api/auth/google/link", () => {
  it("400 when the pending-link cookie is missing", async () => {
    requireUserId.mockResolvedValue("u1");
    const res = await POST(req({ authVerifier: "v" }));
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("collision path: resolves by cookie email, verifies passphrase, links, creates session", async () => {
    cookieVal = validCookie();
    requireUserId.mockResolvedValue(null); // not logged in
    findUnique.mockResolvedValue({ id: "u1", email: "a@example.com", authVerifierHash: "hash:v", googleId: null });
    update.mockResolvedValue({});
    const res = await POST(req({ authVerifier: "v" }));
    expect(res.status).toBe(200);
    expect(findUnique).toHaveBeenCalledWith({ where: { email: "a@example.com" } });
    expect(update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { googleId: "g-new" } });
    expect(setCookie(res, PENDING_LINK_COOKIE)).toBe(""); // cleared
    expect(setCookie(res, "legacy_session")).toBe("sess-new");
  });

  it("settings path: resolves by session, no new session cookie", async () => {
    cookieVal = validCookie();
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ id: "u1", email: "a@example.com", authVerifierHash: "hash:v", googleId: null });
    update.mockResolvedValue({});
    const res = await POST(req({ authVerifier: "v" }));
    expect(res.status).toBe(200);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "u1" } });
    expect(setCookie(res, "legacy_session")).toBeUndefined();
  });

  it("401 on wrong passphrase", async () => {
    cookieVal = validCookie();
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ id: "u1", email: "a@example.com", authVerifierHash: "hash:right", googleId: null });
    const res = await POST(req({ authVerifier: "wrong" }));
    expect(res.status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it("401 when the target account has no password login", async () => {
    cookieVal = validCookie();
    requireUserId.mockResolvedValue(null);
    findUnique.mockResolvedValue({ id: "u1", email: "a@example.com", authVerifierHash: null, googleId: null });
    expect((await POST(req({ authVerifier: "v" }))).status).toBe(401);
  });

  it("409 when the account already has Google linked", async () => {
    cookieVal = validCookie();
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ id: "u1", email: "a@example.com", authVerifierHash: "hash:v", googleId: "g-old" });
    const res = await POST(req({ authVerifier: "v" }));
    expect(res.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it("409 when the googleId is already linked elsewhere (unique violation)", async () => {
    cookieVal = validCookie();
    requireUserId.mockResolvedValue("u1");
    findUnique.mockResolvedValue({ id: "u1", email: "a@example.com", authVerifierHash: "hash:v", googleId: null });
    update.mockRejectedValue(new Error("Unique constraint failed"));
    expect((await POST(req({ authVerifier: "v" }))).status).toBe(409);
  });

  it("500 when LINK_STATE_SECRET is unset", async () => {
    const saved = process.env.LINK_STATE_SECRET;
    delete process.env.LINK_STATE_SECRET;
    try {
      expect((await POST(req({ authVerifier: "v" }))).status).toBe(500);
    } finally {
      process.env.LINK_STATE_SECRET = saved;
    }
  });
});
