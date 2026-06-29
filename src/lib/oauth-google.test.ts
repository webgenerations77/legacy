import { describe, it, expect, beforeAll } from "vitest";
import { SignJWT, generateKeyPair } from "jose";
import { createGoogleAuthUrl, verifyGoogleIdToken } from "@/lib/oauth-google";

let privateKey: CryptoKey;
let publicKey: CryptoKey;

beforeAll(async () => {
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  process.env.APP_BASE_URL = "http://localhost:3000";
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
});

async function signIdToken(claims: Record<string, unknown>, sub = "google-sub-123") {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(sub)
    .setIssuer("https://accounts.google.com")
    .setAudience("test-client-id")
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe("oauth-google", () => {
  it("builds a Google authorization URL with the expected params", () => {
    const url = createGoogleAuthUrl("state-xyz", "verifier-abc");
    expect(url.host).toBe("accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/auth/google/callback",
    );
    expect(url.searchParams.get("state")).toBe("state-xyz");
    expect(url.searchParams.get("scope")).toContain("email");
    expect(url.searchParams.get("code_challenge")).toBeTruthy(); // PKCE
  });

  it("verifies a well-formed Google ID token and extracts identity", async () => {
    const token = await signIdToken({ email: "jane@example.com", email_verified: true });
    const id = await verifyGoogleIdToken(token, { keySet: publicKey, audience: "test-client-id" });
    expect(id).toEqual({
      googleId: "google-sub-123",
      email: "jane@example.com",
      emailVerified: true,
    });
  });

  it("reports emailVerified=false when the claim is not true", async () => {
    const token = await signIdToken({ email: "jane@example.com", email_verified: false });
    const id = await verifyGoogleIdToken(token, { keySet: publicKey, audience: "test-client-id" });
    expect(id.emailVerified).toBe(false);
  });

  it("rejects a token signed by the wrong key", async () => {
    const wrong = await generateKeyPair("RS256");
    const token = await new SignJWT({ email: "x@example.com", email_verified: true })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("s")
      .setIssuer("https://accounts.google.com")
      .setAudience("test-client-id")
      .setExpirationTime("5m")
      .sign(wrong.privateKey);
    await expect(
      verifyGoogleIdToken(token, { keySet: publicKey, audience: "test-client-id" }),
    ).rejects.toThrow();
  });
});
