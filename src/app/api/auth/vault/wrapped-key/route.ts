import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/route-auth";
import { noStore } from "@/lib/http";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { wrappedKeyCiphertext: true, wrappedKeyIv: true },
  });
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  if (!user.wrappedKeyCiphertext || !user.wrappedKeyIv) {
    return noStore(NextResponse.json({ wrappedKeyCiphertext: null }));
  }
  return noStore(
    NextResponse.json({
      wrappedKeyCiphertext: user.wrappedKeyCiphertext,
      wrappedKeyIv: user.wrappedKeyIv,
    }),
  );
}
