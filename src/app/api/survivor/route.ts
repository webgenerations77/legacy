import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/route-auth";
import { hashVerifier } from "@/lib/auth";
import { readJsonBody } from "@/lib/http";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const row = await prisma.survivorAccess.findUnique({
    where: { userId },
    select: { updatedAt: true },
  });
  return NextResponse.json({
    armed: !!row,
    updatedAt: row ? row.updatedAt.toISOString() : null,
  });
}

export async function POST(req: Request) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;

  const survivorSalt = typeof body.survivorSalt === "string" ? body.survivorSalt : "";
  const survivorAuthVerifier =
    typeof body.survivorAuthVerifier === "string" ? body.survivorAuthVerifier : "";
  const escrowCiphertext = typeof body.escrowCiphertext === "string" ? body.escrowCiphertext : "";
  const escrowIv = typeof body.escrowIv === "string" ? body.escrowIv : "";
  if (!survivorSalt || !survivorAuthVerifier || !escrowCiphertext || !escrowIv) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }

  const survivorAuthVerifierHash = await hashVerifier(survivorAuthVerifier);
  await prisma.survivorAccess.upsert({
    where: { userId },
    create: { userId, survivorSalt, survivorAuthVerifierHash, escrowCiphertext, escrowIv },
    update: { survivorSalt, survivorAuthVerifierHash, escrowCiphertext, escrowIv },
  });
  return NextResponse.json({ ok: true }, { status: 201 });
}

export async function DELETE() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  await prisma.survivorAccess.deleteMany({ where: { userId } });
  return NextResponse.json({ ok: true });
}
