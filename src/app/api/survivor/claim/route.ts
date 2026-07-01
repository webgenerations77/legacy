import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyVerifier, DECOY_VERIFIER_HASH } from "@/lib/auth";
import { readJsonBody, noStore } from "@/lib/http";

const denied = () => NextResponse.json({ error: "Could not unlock." }, { status: 401 });
const blobSelect = { select: { id: true, ciphertext: true, iv: true }, orderBy: { createdAt: "desc" } } as const;

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return denied();

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const survivorAuthVerifier =
    typeof body.survivorAuthVerifier === "string" ? body.survivorAuthVerifier : "";
  if (!email || !survivorAuthVerifier) {
    // Still pay one bcrypt comparison so a blank request costs the same.
    await verifyVerifier(survivorAuthVerifier, DECOY_VERIFIER_HASH);
    return denied();
  }

  // Phase 1: fetch ONLY the survivor row — no vault load yet.
  const access = await prisma.survivorAccess.findFirst({
    where: { user: { email } },
    select: { userId: true, escrowCiphertext: true, escrowIv: true, survivorAuthVerifierHash: true },
  });

  // Always run one comparison (real hash if armed, decoy otherwise) so armed and
  // unarmed accounts are indistinguishable by timing.
  const ok = await verifyVerifier(
    survivorAuthVerifier,
    access?.survivorAuthVerifierHash ?? DECOY_VERIFIER_HASH,
  );
  if (!access || !ok) return denied();

  // Phase 2: only now load the full vault.
  const records = await prisma.user.findUnique({
    where: { id: access.userId },
    select: {
      vaultItems: blobSelect,
      financialAccounts: blobSelect,
      bills: blobSelect,
      loans: blobSelect,
      beneficiaries: blobSelect,
      documents: {
        select: { id: true, metaCiphertext: true, metaIv: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
      obituary: { select: { intake: true, draft: true } },
    },
  });
  if (!records) return denied();

  return noStore(
    NextResponse.json({
      escrow: { ciphertext: access.escrowCiphertext, iv: access.escrowIv },
      records: {
        items: records.vaultItems,
        accounts: records.financialAccounts,
        bills: records.bills,
        loans: records.loans,
        beneficiaries: records.beneficiaries,
        documents: records.documents,
        obituary: records.obituary,
      },
    }),
  );
}
