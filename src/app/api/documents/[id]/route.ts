import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/route-auth";
import { noStore } from "@/lib/http";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { id } = await ctx.params;
  const doc = await prisma.document.findFirst({
    where: { id, userId },
    select: { contentCiphertext: true, contentIv: true },
  });
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return noStore(NextResponse.json(doc));
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { id } = await ctx.params;
  const { count } = await prisma.document.deleteMany({ where: { id, userId } });
  if (count === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
