import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/route-auth";
import { readJsonBody, noStore } from "@/lib/http";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const row = await prisma.readinessState.findUnique({
    where: { userId },
    select: { ciphertext: true, iv: true },
  });
  return noStore(NextResponse.json({ state: row }));
}

export async function PUT(req: Request) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;

  const ciphertext = typeof body.ciphertext === "string" ? body.ciphertext : "";
  const iv = typeof body.iv === "string" ? body.iv : "";
  if (!ciphertext || !iv) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }

  await prisma.readinessState.upsert({
    where: { userId },
    create: { userId, ciphertext, iv },
    update: { ciphertext, iv },
  });
  return NextResponse.json({ ok: true });
}
