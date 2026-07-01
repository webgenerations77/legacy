import { NextResponse } from "next/server";
import { generateState, generateCodeVerifier } from "arctic";
import { createGoogleAuthUrl } from "@/lib/oauth-google";

const TEN_MINUTES = 600;

export async function GET(req: Request) {
  const intent = new URL(req.url).searchParams.get("intent") === "link" ? "link" : "login";

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const url = createGoogleAuthUrl(state, codeVerifier);

  const res = NextResponse.redirect(url);
  const opts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: TEN_MINUTES,
  };
  res.cookies.set("google_oauth_state", state, opts);
  res.cookies.set("google_code_verifier", codeVerifier, opts);
  res.cookies.set("google_oauth_intent", intent, opts);
  return res;
}
