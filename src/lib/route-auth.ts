import { cookies } from "next/headers";
import { getSessionUserId } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session-cookie";

/** Resolve the logged-in user id from the session cookie (login gate; no vault check). */
export async function requireUserId(): Promise<string | null> {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  return getSessionUserId(sid);
}
