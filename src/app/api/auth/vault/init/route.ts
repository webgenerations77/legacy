import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getSessionUserId, hashVerifier } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import { readJsonBody } from "@/lib/http";

export async function POST(req: Request) {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  const userId = await getSessionUserId(sid);
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const salt = typeof body.salt === "string" ? body.salt : "";
  const authVerifier = typeof body.authVerifier === "string" ? body.authVerifier : "";
  if (!salt || !authVerifier) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { kdfSalt: true } });
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (user.kdfSalt != null) {
    return NextResponse.json({ error: "Vault already initialized." }, { status: 409 });
  }

  await prisma.user.update({
    where: { id: userId },
    data: { kdfSalt: salt, authVerifierHash: await hashVerifier(authVerifier) },
  });
  return NextResponse.json({ ok: true });
}
