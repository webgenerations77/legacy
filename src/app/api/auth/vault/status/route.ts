import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session-cookie";

export async function GET() {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  const userId = await getSessionUserId(sid);
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { kdfSalt: true } });
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  return NextResponse.json({ initialized: user.kdfSalt != null, salt: user.kdfSalt ?? undefined });
}
