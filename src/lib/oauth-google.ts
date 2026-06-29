import { Google } from "arctic";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface GoogleIdentity {
  googleId: string;
  email: string;
  emailVerified: boolean;
}

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function redirectUri(): string {
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  return `${base}/api/auth/google/callback`;
}

function googleClient(): Google {
  return new Google(reqEnv("GOOGLE_CLIENT_ID"), reqEnv("GOOGLE_CLIENT_SECRET"), redirectUri());
}

export function createGoogleAuthUrl(state: string, codeVerifier: string): URL {
  return googleClient().createAuthorizationURL(state, codeVerifier, ["openid", "email", "profile"]);
}

const GOOGLE_JWKS: JWTVerifyGetKey = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

export async function verifyGoogleIdToken(
  idToken: string,
  opts?: { keySet?: JWTVerifyGetKey | CryptoKey; issuer?: string | string[]; audience?: string },
): Promise<GoogleIdentity> {
  const keySet = opts?.keySet ?? GOOGLE_JWKS;
  const issuer = opts?.issuer ?? ["https://accounts.google.com", "accounts.google.com"];
  const audience = opts?.audience ?? reqEnv("GOOGLE_CLIENT_ID");
  const { payload } = await jwtVerify(idToken, keySet as JWTVerifyGetKey, { issuer, audience });
  const googleId = typeof payload.sub === "string" ? payload.sub : "";
  const email = typeof payload.email === "string" ? payload.email : "";
  const emailVerified = payload.email_verified === true;
  if (!googleId || !email) throw new Error("Invalid Google identity token.");
  return { googleId, email, emailVerified };
}

// Network step (token exchange + verify). Thin glue; exercised end-to-end manually
// and via the callback route — not unit-tested (needs a live Google token endpoint).
export async function resolveGoogleIdentity(
  code: string,
  codeVerifier: string,
): Promise<GoogleIdentity> {
  const tokens = await googleClient().validateAuthorizationCode(code, codeVerifier);
  return verifyGoogleIdToken(tokens.idToken());
}
