import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { resolveGoogleIdentity } from "@/lib/oauth-google";
import { findOrCreateGoogleUser } from "@/lib/google-user";
import { createSession } from "@/lib/auth";
import { SESSION_COOKIE, sessionCookieOptions, sessionExpiry } from "@/lib/session-cookie";
import {
  PENDING_LINK_COOKIE,
  pendingLinkCookieOptions,
  signPendingLink,
  linkStateSecret,
} from "@/lib/link-token";

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
  const intent = jar.get("google_oauth_intent")?.value === "link" ? "link" : "login";

  const clearOauth = (res: NextResponse) => {
    res.cookies.delete("google_oauth_state");
    res.cookies.delete("google_code_verifier");
    res.cookies.delete("google_oauth_intent");
    return res;
  };
  const fail = (reason: string) =>
    clearOauth(NextResponse.redirect(new URL(`/unlock?error=${reason}`, appBaseUrl())));

  // Set the pending-link cookie and send the user to `path` to confirm with their passphrase.
  const toConfirm = (path: string, googleId: string, email: string) => {
    const secret = linkStateSecret();
    if (!secret) return fail("server_misconfig");
    const res = clearOauth(NextResponse.redirect(new URL(path, appBaseUrl())));
    res.cookies.set(PENDING_LINK_COOKIE, signPendingLink({ googleId, email }, secret), pendingLinkCookieOptions());
    return res;
  };

  if (!code || !state || !storedState || !codeVerifier || state !== storedState) {
    return fail("google_failed");
  }

  try {
    const identity = await resolveGoogleIdentity(code, codeVerifier);
    if (!identity.emailVerified) return fail("google_unverified");

    // Explicit link intent from the account page — never auto-links.
    if (intent === "link") {
      return toConfirm("/account?link=confirm", identity.googleId, identity.email);
    }

    const result = await findOrCreateGoogleUser(identity);
    if (!result.ok) {
      // Email collides with an existing password account: offer inline linking.
      return toConfirm("/unlock?link=confirm", identity.googleId, identity.email);
    }

    const sessionId = await createSession(result.userId);
    const res = clearOauth(NextResponse.redirect(new URL("/unlock", appBaseUrl())));
    res.cookies.set(SESSION_COOKIE, sessionId, sessionCookieOptions(sessionExpiry()));
    return res;
  } catch {
    return fail("google_failed");
  }
}
