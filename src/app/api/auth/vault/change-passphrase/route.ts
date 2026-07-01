import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyVerifier, hashVerifier } from "@/lib/auth";
import { requireUserId } from "@/lib/route-auth";
import { readJsonBody } from "@/lib/http";

export async function POST(req: Request) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;

  const currentAuthVerifier =
    typeof body.currentAuthVerifier === "string" ? body.currentAuthVerifier : "";
  const kdfSalt = typeof body.kdfSalt === "string" ? body.kdfSalt : "";
  const wrappedKeyCiphertext =
    typeof body.wrappedKeyCiphertext === "string" ? body.wrappedKeyCiphertext : "";
  const wrappedKeyIv = typeof body.wrappedKeyIv === "string" ? body.wrappedKeyIv : "";
  const authVerifier = typeof body.authVerifier === "string" ? body.authVerifier : "";

  if (!kdfSalt || !wrappedKeyCiphertext || !wrappedKeyIv || !authVerifier) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { authVerifierHash: true },
  });
  const generic = NextResponse.json({ error: "That passphrase didn't match." }, { status: 401 });
  if (!user || !user.authVerifierHash) return generic;
  if (!(await verifyVerifier(currentAuthVerifier, user.authVerifierHash))) return generic;

  await prisma.user.update({
    where: { id: userId },
    data: {
      kdfSalt,
      wrappedKeyCiphertext,
      wrappedKeyIv,
      authVerifierHash: await hashVerifier(authVerifier),
    },
  });
  return NextResponse.json({ ok: true });
}
