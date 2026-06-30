import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import { readJsonBody } from "@/lib/http";

type RecordModel = "vaultItem" | "financialAccount" | "bill" | "loan" | "beneficiary";

interface BlobItemDelegate {
  updateMany(args: {
    where: { id: string; userId: string };
    data: { ciphertext: string; iv: string };
  }): Promise<{ count: number }>;
  deleteMany(args: { where: { id: string; userId: string } }): Promise<{ count: number }>;
}

async function requireUser(): Promise<string | null> {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  return getSessionUserId(sid);
}

export function createEncryptedRecordItemRoute(opts: { model: RecordModel }) {
  const delegate = ((): BlobItemDelegate => {
    switch (opts.model) {
      case "vaultItem":
        return prisma.vaultItem as unknown as BlobItemDelegate;
      case "financialAccount":
        return prisma.financialAccount as unknown as BlobItemDelegate;
      case "bill":
        return prisma.bill as unknown as BlobItemDelegate;
      case "loan":
        return prisma.loan as unknown as BlobItemDelegate;
      case "beneficiary":
        return prisma.beneficiary as unknown as BlobItemDelegate;
    }
  })();

  async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const userId = await requireUser();
    if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = await readJsonBody(req);
    if (body instanceof NextResponse) return body;
    const ciphertext = typeof body.ciphertext === "string" ? body.ciphertext : "";
    const iv = typeof body.iv === "string" ? body.iv : "";
    if (!ciphertext || !iv) {
      return NextResponse.json({ error: "Missing fields." }, { status: 400 });
    }

    const { id } = await ctx.params;
    const { count } = await delegate.updateMany({
      where: { id, userId },
      data: { ciphertext, iv },
    });
    if (count === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
    const userId = await requireUser();
    if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const { id } = await ctx.params;
    const { count } = await delegate.deleteMany({ where: { id, userId } });
    if (count === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  return { PUT, DELETE };
}
