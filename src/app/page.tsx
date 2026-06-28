import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/session-cookie";

export default async function Home() {
  const hasSession = (await cookies()).has(SESSION_COOKIE);
  redirect(hasSession ? "/vault" : "/unlock");
}
