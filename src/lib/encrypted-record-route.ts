import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import { readJsonBody } from "@/lib/http";

type RecordModel = "vaultItem" | "financialAccount" | "bill" | "loan";

interface BlobRow {
  id: string;
  ciphertext: string;
  iv: string;
}

// The narrow surface of a Prisma delegate this factory uses. Prisma's
// generated delegates each satisfy this shape; the `as unknown as` bridge
// below sidesteps the union-of-overloads typing without resorting to `any`.
interface BlobDelegate {
  findMany(args: {
    where: { userId: string };
    orderBy: { createdAt: "desc" };
    select: { id: true; ciphertext: true; iv: true };
  }): Promise<BlobRow[]>;
  create(args: {
    data: { userId: string; ciphertext: string; iv: string };
    select: { id: true };
  }): Promise<{ id: string }>;
}

async function requireUser(): Promise<string | null> {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  return getSessionUserId(sid);
}

export function createEncryptedRecordRoute(opts: { model: RecordModel; listKey: string }) {
  const delegate = ((): BlobDelegate => {
    switch (opts.model) {
      case "vaultItem":
        return prisma.vaultItem as unknown as BlobDelegate;
      case "financialAccount":
        return prisma.financialAccount as unknown as BlobDelegate;
      case "bill":
        return prisma.bill as unknown as BlobDelegate;
      case "loan":
        return prisma.loan as unknown as BlobDelegate;
    }
  })();

  async function GET() {
    const userId = await requireUser();
    if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const rows = await delegate.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, ciphertext: true, iv: true },
    });
    return NextResponse.json({ [opts.listKey]: rows });
  }

  async function POST(req: Request) {
    const userId = await requireUser();
    if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = await readJsonBody(req);
    if (body instanceof NextResponse) return body;
    const ciphertext = typeof body.ciphertext === "string" ? body.ciphertext : "";
    const iv = typeof body.iv === "string" ? body.iv : "";
    if (!ciphertext || !iv) {
      return NextResponse.json({ error: "Missing fields." }, { status: 400 });
    }

    const created = await delegate.create({
      data: { userId, ciphertext, iv },
      select: { id: true },
    });
    return NextResponse.json({ id: created.id }, { status: 201 });
  }

  return { GET, POST };
}
