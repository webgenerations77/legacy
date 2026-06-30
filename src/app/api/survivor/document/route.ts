import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyVerifier } from "@/lib/auth";
import { readJsonBody } from "@/lib/http";

const denied = () => NextResponse.json({ error: "Could not unlock." }, { status: 401 });

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return denied();

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const survivorAuthVerifier =
    typeof body.survivorAuthVerifier === "string" ? body.survivorAuthVerifier : "";
  const documentId = typeof body.documentId === "string" ? body.documentId : "";
  if (!email || !survivorAuthVerifier || !documentId) return denied();

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, survivorAccess: { select: { survivorAuthVerifierHash: true } } },
  });
  if (!user || !user.survivorAccess) return denied();

  const ok = await verifyVerifier(survivorAuthVerifier, user.survivorAccess.survivorAuthVerifierHash);
  if (!ok) return denied();

  const doc = await prisma.document.findFirst({
    where: { id: documentId, userId: user.id },
    select: { contentCiphertext: true, contentIv: true },
  });
  if (!doc) return denied();
  return NextResponse.json(doc);
}
