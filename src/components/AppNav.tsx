"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { useKey } from "@/app/providers/KeyProvider";

export function AppNav() {
  const router = useRouter();
  const { setMasterKey } = useKey();

  async function onLogout() {
    try {
      await api.logout();
    } catch {
      // best-effort: always clear the in-memory key and leave
    }
    setMasterKey(null);
    router.replace("/unlock");
  }

  return (
    <nav className="appnav">
      <div className="navlinks">
        <Link href="/vault">Vault</Link>
        <Link href="/accounts">Accounts</Link>
      </div>
      <button type="button" className="linkbtn" onClick={onLogout}>
        Lock &amp; sign out
      </button>
    </nav>
  );
}
