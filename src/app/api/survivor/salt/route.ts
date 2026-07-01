import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { readJsonBody } from "@/lib/http";
import { decoySalt } from "@/lib/survivor";

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const secret = process.env.SURVIVOR_SALT_SECRET ?? "";
  if (!secret) {
    return NextResponse.json({ error: "Server misconfiguration." }, { status: 500 });
  }

  const user = email
    ? await prisma.user.findUnique({
        where: { email },
        select: { survivorAccess: { select: { survivorSalt: true } } },
      })
    : null;

  const salt = user?.survivorAccess?.survivorSalt ?? (await decoySalt(secret, email));
  return NextResponse.json({ salt });
}
