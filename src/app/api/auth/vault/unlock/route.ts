import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getSessionUserId, verifyVerifier } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import { readJsonBody } from "@/lib/http";

export async function POST(req: Request) {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  const userId = await getSessionUserId(sid);
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const authVerifier = typeof body.authVerifier === "string" ? body.authVerifier : "";

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { authVerifierHash: true },
  });
  if (!user || !user.authVerifierHash) {
    return NextResponse.json({ error: "Vault not set up." }, { status: 401 });
  }
  if (!(await verifyVerifier(authVerifier, user.authVerifierHash))) {
    return NextResponse.json({ error: "That passphrase didn't match." }, { status: 401 });
  }
  return NextResponse.json({ ok: true });
}
