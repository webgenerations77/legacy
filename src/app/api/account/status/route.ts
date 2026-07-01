import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/route-auth";
import { noStore } from "@/lib/http";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, googleId: true, authVerifierHash: true },
  });
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  return noStore(NextResponse.json({
    email: user.email,
    googleLinked: user.googleId != null,
    hasPassword: user.authVerifierHash != null,
  }));
}
