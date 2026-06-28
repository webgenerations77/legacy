"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api-client";
import { BrandHeader } from "@/components/Logo";
import { useKey } from "@/app/providers/KeyProvider";
import { deriveMasterKey, deriveAuthVerifier } from "@/lib/crypto";

export default function UnlockPage() {
  const router = useRouter();
  const { setMasterKey } = useKey();
  const [email, setEmail] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { salt } = await api.getSalt(email).catch(() => {
        throw new Error("That email or passphrase didn't match.");
      });
      const masterKey = await deriveMasterKey(passphrase, salt);
      const authVerifier = await deriveAuthVerifier(masterKey, passphrase);
      await api.login(email, authVerifier);
      setMasterKey(masterKey);
      router.push("/vault");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <form className="card" onSubmit={onSubmit}>
        <BrandHeader />
        <h1>Welcome back</h1>
        <p className="subtle">Enter your passphrase to unlock your vault.</p>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email}
          onChange={(e) => setEmail(e.target.value)} required />
        <label htmlFor="pass">Passphrase</label>
        <input id="pass" type="password" value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)} required />
        <button type="submit" disabled={busy}>
          {busy ? "Unlocking…" : "Unlock"}
        </button>
        {error && <p className="error">{error}</p>}
        <p className="link">New here? <Link href="/register">Create your Legacy</Link></p>
      </form>
    </main>
  );
}
