import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { verifyVerifier, createSession, DECOY_VERIFIER_HASH } from "@/lib/auth";
import { requireUserId } from "@/lib/route-auth";
import { SESSION_COOKIE, sessionCookieOptions, sessionExpiry } from "@/lib/session-cookie";
import { readJsonBody } from "@/lib/http";
import { PENDING_LINK_COOKIE, verifyPendingLink, linkStateSecret } from "@/lib/link-token";

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const authVerifier = typeof body.authVerifier === "string" ? body.authVerifier : "";

  const secret = linkStateSecret();
  if (!secret) return NextResponse.json({ error: "Server misconfiguration." }, { status: 500 });

  const jar = await cookies();
  const pending = verifyPendingLink(jar.get(PENDING_LINK_COOKIE)?.value, secret);
  if (!pending) {
    return NextResponse.json({ error: "Your linking session expired. Please start again." }, { status: 400 });
  }

  // Resolve the target account server-side — never from the request body.
  const sessionUserId = await requireUserId();
  const user = sessionUserId
    ? await prisma.user.findUnique({ where: { id: sessionUserId } })
    : await prisma.user.findUnique({ where: { email: pending.email.trim().toLowerCase() } });

  const generic = NextResponse.json({ error: "That passphrase didn't match." }, { status: 401 });

  // One bcrypt compare regardless of path (timing parity); decoy when no real hash.
  const ok = await verifyVerifier(authVerifier, user?.authVerifierHash ?? DECOY_VERIFIER_HASH);
  if (!user || !user.authVerifierHash || !ok) return generic;

  if (user.googleId) {
    return NextResponse.json({ error: "This account already has Google linked." }, { status: 409 });
  }

  try {
    await prisma.user.update({ where: { id: user.id }, data: { googleId: pending.googleId } });
  } catch {
    return NextResponse.json(
      { error: "That Google account is already linked to another account." },
      { status: 409 },
    );
  }

  const res = NextResponse.json({ ok: true });
  if (!sessionUserId) {
    const sid = await createSession(user.id);
    res.cookies.set(SESSION_COOKIE, sid, sessionCookieOptions(sessionExpiry()));
  }
  res.cookies.delete(PENDING_LINK_COOKIE);
  return res;
}
