import { describe, it, expect, vi } from "vitest";

vi.mock("arctic", () => ({
  generateState: () => "state-x",
  generateCodeVerifier: () => "verifier-x",
}));
vi.mock("@/lib/oauth-google", () => ({
  createGoogleAuthUrl: () => new URL("https://accounts.google.com/o/oauth2/v2/auth"),
}));

import { GET } from "./route";

function cookieValue(res: Response, name: string): string | undefined {
  const all = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  const hit = all.find((c) => c.startsWith(`${name}=`));
  return hit?.split(";")[0].split("=")[1];
}

describe("GET /api/auth/google/start", () => {
  it("records intent=login by default", async () => {
    const res = await GET(new Request("http://localhost/api/auth/google/start"));
    expect(cookieValue(res, "google_oauth_intent")).toBe("login");
  });

  it("records intent=link when ?intent=link", async () => {
    const res = await GET(new Request("http://localhost/api/auth/google/start?intent=link"));
    expect(cookieValue(res, "google_oauth_intent")).toBe("link");
  });
});
