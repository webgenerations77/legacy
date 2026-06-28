import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { verifyVerifier, createSession } from "@/lib/auth";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/session-cookie";

export async function POST(req: Request) {
  const { email, authVerifier } = await req.json();
  const generic = NextResponse.json(
    { error: "That email or passphrase didn't match." },
    { status: 401 },
  );
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return generic;
  if (!(await verifyVerifier(authVerifier, user.authVerifierHash))) return generic;

  const sessionId = await createSession(user.id);
  const expiresAt = new Date(
    Date.now() + Number(process.env.SESSION_TTL_HOURS ?? "12") * 3600 * 1000,
  );
  (await cookies()).set(SESSION_COOKIE, sessionId, sessionCookieOptions(expiresAt));
  return NextResponse.json({ ok: true });
}
