import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/route-auth";
import { readJsonBody, noStore } from "@/lib/http";
import { type ObituaryIntake } from "@/lib/obituary";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const row = await prisma.obituary.findUnique({
    where: { userId },
    select: { intake: true, draft: true },
  });
  return noStore(NextResponse.json({ obituary: row }));
}

export async function PUT(req: Request) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;

  const intake = body.intake as ObituaryIntake | undefined;
  const draft = typeof body.draft === "string" ? body.draft : "";
  if (
    !intake ||
    typeof intake.subjectName !== "string" ||
    !intake.subjectName.trim() ||
    !draft.trim()
  ) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }

  await prisma.obituary.upsert({
    where: { userId },
    create: { userId, intake: intake as unknown as Prisma.InputJsonValue, draft },
    update: { intake: intake as unknown as Prisma.InputJsonValue, draft },
  });
  return NextResponse.json({ ok: true });
}
