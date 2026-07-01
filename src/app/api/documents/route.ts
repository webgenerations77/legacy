import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/route-auth";
import { readJsonBody, noStore } from "@/lib/http";
import { MAX_CONTENT_CIPHERTEXT_CHARS, MAX_META_CIPHERTEXT_CHARS } from "@/lib/document";

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

  const body = await readJsonBody(req);
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

  const created = await prisma.document.create({
    data: { userId, metaCiphertext, metaIv, contentCiphertext, contentIv },
    select: { id: true },
  });
  return NextResponse.json({ id: created.id }, { status: 201 });
}
