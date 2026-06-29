import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { verifyVerifier, createSession } from "@/lib/auth";
import { SESSION_COOKIE, sessionCookieOptions, sessionExpiry } from "@/lib/session-cookie";
import { readJsonBody } from "@/lib/http";

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const authVerifier = typeof body.authVerifier === "string" ? body.authVerifier : "";

  const generic = NextResponse.json(
    { error: "That email or passphrase didn't match." },
    { status: 401 },
  );
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return generic;
  if (!user.authVerifierHash) return generic; // Google-only account — no passphrase
  if (!(await verifyVerifier(authVerifier, user.authVerifierHash))) return generic;

  const sessionId = await createSession(user.id);
  const expiresAt = sessionExpiry();
  (await cookies()).set(SESSION_COOKIE, sessionId, sessionCookieOptions(expiresAt));
  return NextResponse.json({ ok: true });
}
