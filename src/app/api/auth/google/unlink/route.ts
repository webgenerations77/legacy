import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyVerifier } from "@/lib/auth";
import { requireUserId } from "@/lib/route-auth";
import { readJsonBody } from "@/lib/http";

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const authVerifier = typeof body.authVerifier === "string" ? body.authVerifier : "";

  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  const generic = NextResponse.json({ error: "That passphrase didn't match." }, { status: 401 });
  if (!user) return generic;
  if (!user.authVerifierHash) {
    return NextResponse.json({ error: "Set a vault passphrase before unlinking Google." }, { status: 409 });
  }
  if (!(await verifyVerifier(authVerifier, user.authVerifierHash))) return generic;

  await prisma.user.update({ where: { id: user.id }, data: { googleId: null } });
  return NextResponse.json({ ok: true });
}
