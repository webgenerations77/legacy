import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { PENDING_LINK_COOKIE, verifyPendingLink, linkStateSecret } from "@/lib/link-token";

export async function GET() {
  const secret = linkStateSecret();
  const jar = await cookies();
  const pending = secret ? verifyPendingLink(jar.get(PENDING_LINK_COOKIE)?.value, secret) : null;
  return NextResponse.json({ email: pending?.email ?? null });
}
