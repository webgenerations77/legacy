import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { deleteSession } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session-cookie";

export async function POST() {
  const jar = await cookies();
  const sid = jar.get(SESSION_COOKIE)?.value;
  if (sid) await deleteSession(sid);
  jar.delete(SESSION_COOKIE);
  return NextResponse.json({ ok: true });
}
