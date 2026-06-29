import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { readJsonBody } from "@/lib/http";

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.kdfSalt) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json({ salt: user.kdfSalt });
}
