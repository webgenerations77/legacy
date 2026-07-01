import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/route-auth";
import { readJsonBody, noStore } from "@/lib/http";
import {
  MAX_CONTENT_CIPHERTEXT_CHARS,
  MAX_META_CIPHERTEXT_CHARS,
  MAX_DOCUMENT_BODY,
  MAX_DOCUMENTS_PER_USER,
  MAX_TOTAL_CONTENT_BYTES,
} from "@/lib/document";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const documents = await prisma.document.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, metaCiphertext: true, metaIv: true, createdAt: true },
  });
  return noStore(NextResponse.json({ documents }));
}

export async function POST(req: Request) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await readJsonBody(req, MAX_DOCUMENT_BODY);
  if (body instanceof NextResponse) return body;
  const metaCiphertext = typeof body.metaCiphertext === "string" ? body.metaCiphertext : "";
  const metaIv = typeof body.metaIv === "string" ? body.metaIv : "";
  const contentCiphertext = typeof body.contentCiphertext === "string" ? body.contentCiphertext : "";
  const contentIv = typeof body.contentIv === "string" ? body.contentIv : "";
  if (!metaCiphertext || !metaIv || !contentCiphertext || !contentIv) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }
  if (metaCiphertext.length > MAX_META_CIPHERTEXT_CHARS) {
    return NextResponse.json({ error: "File is too large." }, { status: 400 });
  }
  if (contentCiphertext.length > MAX_CONTENT_CIPHERTEXT_CHARS) {
    return NextResponse.json({ error: "File is too large." }, { status: 400 });
  }

  // Per-user quota: one indexed aggregate over this user's documents.
  const [usage] = await prisma.$queryRaw<{ n: bigint; bytes: bigint }[]>`
    SELECT COUNT(*)::bigint AS n, COALESCE(SUM(LENGTH("contentCiphertext")), 0)::bigint AS bytes
    FROM "Document" WHERE "userId" = ${userId}
  `;
  if (Number(usage.n) >= MAX_DOCUMENTS_PER_USER) {
    return NextResponse.json({ error: "Document limit reached." }, { status: 409 });
  }
  if (Number(usage.bytes) + contentCiphertext.length > MAX_TOTAL_CONTENT_BYTES) {
    return NextResponse.json({ error: "Storage limit reached." }, { status: 409 });
  }

  const created = await prisma.document.create({
    data: { userId, metaCiphertext, metaIv, contentCiphertext, contentIv },
    select: { id: true },
  });
  return NextResponse.json({ id: created.id }, { status: 201 });
}
