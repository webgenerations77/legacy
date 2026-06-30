import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyVerifier } from "@/lib/auth";
import { readJsonBody } from "@/lib/http";

const DENIED = NextResponse.json({ error: "Could not unlock." }, { status: 401 });
const blobSelect = { select: { id: true, ciphertext: true, iv: true }, orderBy: { createdAt: "desc" } } as const;

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const survivorAuthVerifier =
    typeof body.survivorAuthVerifier === "string" ? body.survivorAuthVerifier : "";
  if (!email || !survivorAuthVerifier) {
    return NextResponse.json({ error: "Could not unlock." }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      survivorAccess: true,
      vaultItems: blobSelect,
      financialAccounts: blobSelect,
      bills: blobSelect,
      loans: blobSelect,
      beneficiaries: blobSelect,
      obituary: { select: { intake: true, draft: true } },
    },
  });

  if (!user || !user.survivorAccess) return DENIED;
  const ok = await verifyVerifier(survivorAuthVerifier, user.survivorAccess.survivorAuthVerifierHash);
  if (!ok) return DENIED;

  return NextResponse.json({
    escrow: {
      ciphertext: user.survivorAccess.escrowCiphertext,
      iv: user.survivorAccess.escrowIv,
    },
    records: {
      items: user.vaultItems,
      accounts: user.financialAccounts,
      bills: user.bills,
      loans: user.loans,
      beneficiaries: user.beneficiaries,
      obituary: user.obituary,
    },
  });
}
