import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashVerifier } from "@/lib/auth";
import { readJsonBody } from "@/lib/http";

export async function POST(req: Request) {
  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const salt = typeof body.salt === "string" ? body.salt : "";
  const authVerifier = typeof body.authVerifier === "string" ? body.authVerifier : "";

  if (!email || !salt || !authVerifier) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json(
      { error: "An account with this email already exists." },
      { status: 409 },
    );
  }
  await prisma.user.create({
    data: { email, kdfSalt: salt, authVerifierHash: await hashVerifier(authVerifier) },
  });
  return NextResponse.json({ ok: true }, { status: 201 });
}
