import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session-cookie";

async function requireUser(): Promise<string | null> {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  return getSessionUserId(sid);
}

export async function GET() {
  const userId = await requireUser();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const items = await prisma.vaultItem.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, ciphertext: true, iv: true },
  });
  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  const userId = await requireUser();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { ciphertext, iv } = await req.json();
  if (!ciphertext || !iv) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }
  const item = await prisma.vaultItem.create({
    data: { userId, ciphertext, iv },
    select: { id: true },
  });
  return NextResponse.json({ id: item.id }, { status: 201 });
}
