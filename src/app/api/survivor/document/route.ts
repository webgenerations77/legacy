import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyVerifier, DECOY_VERIFIER_HASH } from "@/lib/auth";
import { readJsonBody, noStore } from "@/lib/http";

const denied = () => NextResponse.json({ error: "Could not unlock." }, { status: 401 });

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return denied();

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const survivorAuthVerifier =
    typeof body.survivorAuthVerifier === "string" ? body.survivorAuthVerifier : "";
  const documentId = typeof body.documentId === "string" ? body.documentId : "";
  if (!email || !survivorAuthVerifier || !documentId) {
    await verifyVerifier(survivorAuthVerifier, DECOY_VERIFIER_HASH);
    return denied();
  }

  const access = await prisma.survivorAccess.findFirst({
    where: { user: { email } },
    select: { userId: true, survivorAuthVerifierHash: true },
  });
  const ok = await verifyVerifier(
    survivorAuthVerifier,
    access?.survivorAuthVerifierHash ?? DECOY_VERIFIER_HASH,
  );
  if (!access || !ok) return denied();

  const doc = await prisma.document.findFirst({
    where: { id: documentId, userId: access.userId },
    select: { contentCiphertext: true, contentIv: true },
  });
  if (!doc) return denied();
  return noStore(NextResponse.json(doc));
}
