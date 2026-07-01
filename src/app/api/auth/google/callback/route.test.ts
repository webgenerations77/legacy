import { describe, it, expect, vi, beforeEach } from "vitest";

const cookieStore = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => {
      const v = cookieStore.get(n);
      return v === undefined ? undefined : { value: v };
    },
  }),
}));

const resolveGoogleIdentity = vi.fn();
vi.mock("@/lib/oauth-google", () => ({ resolveGoogleIdentity: (...a: unknown[]) => resolveGoogleIdentity(...a) }));

const findOrCreateGoogleUser = vi.fn();
vi.mock("@/lib/google-user", () => ({ findOrCreateGoogleUser: (...a: unknown[]) => findOrCreateGoogleUser(...a) }));

vi.mock("@/lib/auth", () => ({ createSession: async () => "sess-1" }));

process.env.LINK_STATE_SECRET = "callback-secret";
process.env.APP_BASE_URL = "http://localhost:3000";

import { GET } from "./route";
import { verifyPendingLink, PENDING_LINK_COOKIE } from "@/lib/link-token";

function setCookies(entries: Record<string, string>) {
  cookieStore.clear();
  for (const [k, v] of Object.entries(entries)) cookieStore.set(k, v);
}
function req() {
  return new Request("http://localhost/api/auth/google/callback?code=abc&state=s");
}
function setCookie(res: Response, name: string): string | undefined {
  const all = res.headers.getSetCookie?.() ?? [];
  return all.find((c) => c.startsWith(`${name}=`))?.split(";")[0].split("=")[1];
}

beforeEach(() => {
  resolveGoogleIdentity.mockReset();
  findOrCreateGoogleUser.mockReset();
});

describe("GET /api/auth/google/callback", () => {
  const identity = { googleId: "g-1", email: "a@example.com", emailVerified: true };

  it("login: new/known Google user gets a session and lands on /unlock", async () => {
    setCookies({ google_oauth_state: "s", google_code_verifier: "v", google_oauth_intent: "login" });
    resolveGoogleIdentity.mockResolvedValue(identity);
    findOrCreateGoogleUser.mockResolvedValue({ ok: true, userId: "u1" });
    const res = await GET(req());
    expect(res.headers.get("location")).toBe("http://localhost:3000/unlock");
    expect(setCookie(res, "legacy_session")).toBe("sess-1");
  });

  it("login collision: sets a valid pending-link cookie and redirects to confirm", async () => {
    setCookies({ google_oauth_state: "s", google_code_verifier: "v", google_oauth_intent: "login" });
    resolveGoogleIdentity.mockResolvedValue(identity);
    findOrCreateGoogleUser.mockResolvedValue({ ok: false, reason: "email_taken" });
    const res = await GET(req());
    expect(res.headers.get("location")).toBe("http://localhost:3000/unlock?link=confirm");
    const cookie = setCookie(res, PENDING_LINK_COOKIE);
    expect(verifyPendingLink(cookie, "callback-secret")).toEqual({ googleId: "g-1", email: "a@example.com" });
  });

  it("link intent: sets pending-link cookie and redirects to /account confirm (no find-or-create)", async () => {
    setCookies({ google_oauth_state: "s", google_code_verifier: "v", google_oauth_intent: "link" });
    resolveGoogleIdentity.mockResolvedValue(identity);
    const res = await GET(req());
    expect(res.headers.get("location")).toBe("http://localhost:3000/account?link=confirm");
    expect(findOrCreateGoogleUser).not.toHaveBeenCalled();
    expect(verifyPendingLink(setCookie(res, PENDING_LINK_COOKIE), "callback-secret")).toEqual({
      googleId: "g-1",
      email: "a@example.com",
    });
  });

  it("refuses an unverified Google email", async () => {
    setCookies({ google_oauth_state: "s", google_code_verifier: "v", google_oauth_intent: "login" });
    resolveGoogleIdentity.mockResolvedValue({ ...identity, emailVerified: false });
    const res = await GET(req());
    expect(res.headers.get("location")).toBe("http://localhost:3000/unlock?error=google_unverified");
  });
});
