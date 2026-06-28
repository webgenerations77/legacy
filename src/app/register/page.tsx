"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api-client";
import { BrandHeader } from "@/components/Logo";
import { generateSalt, deriveMasterKey, deriveAuthVerifier } from "@/lib/crypto";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const salt = generateSalt();
      const masterKey = await deriveMasterKey(passphrase, salt);
      const authVerifier = await deriveAuthVerifier(masterKey, passphrase);
      await api.register(email, salt, authVerifier);
      router.push("/unlock");
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
        <h1>Create your Legacy</h1>
        <p className="subtle">Your passphrase encrypts everything on your device. We never see it.</p>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email}
          onChange={(e) => setEmail(e.target.value)} required />
        <label htmlFor="pass">Passphrase</label>
        <input id="pass" type="password" value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)} required minLength={8} />
        <button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create account"}
        </button>
        {error && <p className="error">{error}</p>}
        <p className="link">Already have one? <Link href="/unlock">Unlock</Link></p>
      </form>
    </main>
  );
}
