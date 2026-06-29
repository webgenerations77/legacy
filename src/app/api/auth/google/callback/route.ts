import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { resolveGoogleIdentity } from "@/lib/oauth-google";
import { findOrCreateGoogleUser } from "@/lib/google-user";
import { createSession } from "@/lib/auth";
import { SESSION_COOKIE, sessionCookieOptions, sessionExpiry } from "@/lib/session-cookie";

function appBaseUrl(): string {
  return process.env.APP_BASE_URL ?? "http://localhost:3000";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const jar = await cookies();
  const storedState = jar.get("google_oauth_state")?.value;
  const codeVerifier = jar.get("google_code_verifier")?.value;

  const fail = (reason: string) =>
    NextResponse.redirect(new URL(`/unlock?error=${reason}`, appBaseUrl()));

  if (!code || !state || !storedState || !codeVerifier || state !== storedState) {
    return fail("google_failed");
  }

  let identity;
  try {
    identity = await resolveGoogleIdentity(code, codeVerifier);
  } catch {
    return fail("google_failed");
  }
  if (!identity.emailVerified) return fail("google_unverified");

  const result = await findOrCreateGoogleUser(identity);
  if (!result.ok) return fail("email_exists");

  const sessionId = await createSession(result.userId);
  const res = NextResponse.redirect(new URL("/unlock", appBaseUrl()));
  res.cookies.set(SESSION_COOKIE, sessionId, sessionCookieOptions(sessionExpiry()));
  res.cookies.delete("google_oauth_state");
  res.cookies.delete("google_code_verifier");
  return res;
}
