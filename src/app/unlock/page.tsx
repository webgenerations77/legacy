"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api-client";
import { BrandHeader } from "@/components/Logo";
import { useKey } from "@/app/providers/KeyProvider";
import { generateSalt, deriveMasterKey, deriveAuthVerifier } from "@/lib/crypto";
import { resolveDataKey } from "@/lib/data-key";

type Mode = "loading" | "email" | "create" | "enter" | "link";

const ERRORS: Record<string, string> = {
  google_failed: "Google sign-in didn't complete. Please try again.",
  google_unverified: "Your Google email isn't verified, so we can't create an account.",
};

export default function UnlockPage() {
  const router = useRouter();
  const { setMasterKey } = useKey();
  const [mode, setMode] = useState<Mode>("loading");
  const [salt, setSalt] = useState("");
  const [email, setEmail] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [linkEmail, setLinkEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("error");
    if (q && ERRORS[q]) setError(ERRORS[q]);

    if (params.get("link") === "confirm") {
      api
        .pendingLink()
        .then(({ email }) => {
          if (email) {
            setLinkEmail(email);
            setMode("link");
          } else {
            setMode("email");
          }
        })
        .catch(() => setMode("email"));
      return;
    }

    api
      .vaultStatus()
      .then((status) => {
        if (status === null) {
          setMode("email");
        } else if (status.initialized) {
          setSalt(status.salt ?? "");
          setMode("enter");
        } else {
          setMode("create");
        }
      })
      .catch(() => setMode("email"));
  }, []);

  async function onEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { salt: s } = await api.getSalt(email).catch(() => {
        throw new Error("That email or passphrase didn't match.");
      });
      const masterKey = await deriveMasterKey(passphrase, s);
      const authVerifier = await deriveAuthVerifier(masterKey, passphrase);
      await api.login(email, authVerifier);
      setMasterKey(await resolveDataKey(masterKey));
      router.push("/vault");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function onCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const s = generateSalt();
      const masterKey = await deriveMasterKey(passphrase, s);
      const authVerifier = await deriveAuthVerifier(masterKey, passphrase);
      await api.vaultInit(s, authVerifier);
      setMasterKey(await resolveDataKey(masterKey));
      router.push("/vault");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function onEnterSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const masterKey = await deriveMasterKey(passphrase, salt);
      const authVerifier = await deriveAuthVerifier(masterKey, passphrase);
      await api.vaultUnlock(authVerifier).catch(() => {
        throw new Error("That passphrase didn't match.");
      });
      setMasterKey(await resolveDataKey(masterKey));
      router.push("/vault");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function onLinkSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { salt: s } = await api.getSalt(linkEmail).catch(() => {
        throw new Error("That passphrase didn't match.");
      });
      const masterKey = await deriveMasterKey(passphrase, s);
      const authVerifier = await deriveAuthVerifier(masterKey, passphrase);
      await api.googleLink(authVerifier).catch(() => {
        throw new Error("That passphrase didn't match.");
      });
      setMasterKey(await resolveDataKey(masterKey));
      router.push("/vault");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (mode === "loading") {
    return (
      <main className="center">
        <div className="card">
          <BrandHeader />
          <p className="subtle">Loading…</p>
        </div>
      </main>
    );
  }

  if (mode === "create") {
    return (
      <main className="center">
        <form className="card" onSubmit={onCreateSubmit}>
          <BrandHeader />
          <h1>Set your vault passphrase</h1>
          <p className="subtle">
            This passphrase encrypts everything on your device. We never see it, and it
            can&apos;t be recovered — choose something memorable.
          </p>
          <label htmlFor="pass">Passphrase</label>
          <input id="pass" type="password" value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)} required minLength={8} />
          <button type="submit" disabled={busy}>
            {busy ? "Setting up…" : "Create vault"}
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      </main>
    );
  }

  if (mode === "enter") {
    return (
      <main className="center">
        <form className="card" onSubmit={onEnterSubmit}>
          <BrandHeader />
          <h1>Welcome back</h1>
          <p className="subtle">Enter your vault passphrase to unlock your vault.</p>
          <label htmlFor="pass">Passphrase</label>
          <input id="pass" type="password" value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)} required />
          <button type="submit" disabled={busy}>
            {busy ? "Unlocking…" : "Unlock"}
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      </main>
    );
  }

  if (mode === "link") {
    return (
      <main className="center">
        <form className="card" onSubmit={onLinkSubmit}>
          <BrandHeader />
          <h1>Link Google to your account</h1>
          <p className="subtle">
            This email already has a Legacy account. Enter your vault passphrase to link Google
            and unlock your vault.
          </p>
          <label htmlFor="pass">Passphrase</label>
          <input id="pass" type="password" value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)} required />
          <button type="submit" disabled={busy}>{busy ? "Linking…" : "Link & unlock"}</button>
          {error && <p className="error">{error}</p>}
        </form>
      </main>
    );
  }

  // mode === "email"
  return (
    <main className="center">
      <form className="card" onSubmit={onEmailSubmit}>
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
        <p className="subtle" style={{ textAlign: "center", margin: "0.5rem 0" }}>or</p>
        <a className="linkbtn" href="/api/auth/google/start">Continue with Google</a>
        {error && <p className="error">{error}</p>}
        <p className="link">New here? <Link href="/register">Create your Legacy</Link></p>
      </form>
    </main>
  );
}
