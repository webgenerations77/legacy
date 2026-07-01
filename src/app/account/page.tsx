"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { BrandHeader } from "@/components/Logo";
import { generateSalt, deriveMasterKey, deriveAuthVerifier, wrapDataKey } from "@/lib/crypto";
import { useKey } from "@/app/providers/KeyProvider";

type Status = { email: string; googleLinked: boolean; hasPassword: boolean };

// Re-derive the authVerifier from the passphrase (re-auth). Needs the account's
// kdf salt, which vaultStatus returns for the logged-in user.
async function deriveVerifier(passphrase: string): Promise<string> {
  const status = await api.vaultStatus();
  const salt = status?.salt;
  if (!salt) throw new Error("Set your vault passphrase first.");
  const masterKey = await deriveMasterKey(passphrase, salt);
  return deriveAuthVerifier(masterKey, passphrase);
}

export default function AccountPage() {
  const router = useRouter();
  const { masterKey } = useKey();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmEmail, setConfirmEmail] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [mode, setMode] = useState<"idle" | "confirm-link" | "unlink">("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [currentPass, setCurrentPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");

  async function refresh(): Promise<boolean> {
    const s = await api.accountStatus();
    if (s === null) {
      router.push("/unlock");
      return false;
    }
    setStatus(s);
    setLoading(false);
    return true;
  }

  useEffect(() => {
    const confirming = new URLSearchParams(window.location.search).get("link") === "confirm";
    (async () => {
      const ok = await refresh();
      if (ok && confirming) {
        const { email } = await api.pendingLink();
        if (email) {
          setConfirmEmail(email);
          setMode("confirm-link");
        }
      }
    })().catch(() => router.push("/unlock"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onConfirmLink(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const authVerifier = await deriveVerifier(passphrase);
      await api.googleLink(authVerifier);
      setNotice("Google is now linked to your account.");
      setMode("idle");
      setPassphrase("");
      window.history.replaceState(null, "", "/account");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't link Google.");
    } finally {
      setBusy(false);
    }
  }

  async function onUnlink(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const authVerifier = await deriveVerifier(passphrase);
      await api.googleUnlink(authVerifier);
      setNotice("Google has been unlinked.");
      setMode("idle");
      setPassphrase("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't unlink Google.");
    } finally {
      setBusy(false);
    }
  }

  async function onChangePassphrase(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      if (!masterKey) throw new Error("Unlock your vault first.");
      if (newPass.length < 8) throw new Error("Your new passphrase must be at least 8 characters.");
      if (newPass !== confirmPass) throw new Error("Your new passphrases don't match.");

      // Re-auth with the current passphrase (needs the current KEK salt).
      const st = await api.vaultStatus();
      const currentSalt = st?.salt;
      if (!currentSalt) throw new Error("We couldn't verify your current passphrase.");
      const currentKek = await deriveMasterKey(currentPass, currentSalt);
      const currentAuthVerifier = await deriveAuthVerifier(currentKek, currentPass);

      // Re-wrap the (unchanged) data key under a fresh KEK.
      const newSalt = generateSalt();
      const newKek = await deriveMasterKey(newPass, newSalt);
      const { ciphertext, iv } = await wrapDataKey(newKek, masterKey);
      const newAuthVerifier = await deriveAuthVerifier(newKek, newPass);

      await api
        .changePassphrase({
          currentAuthVerifier,
          kdfSalt: newSalt,
          wrappedKeyCiphertext: ciphertext,
          wrappedKeyIv: iv,
          authVerifier: newAuthVerifier,
        })
        .catch(() => {
          throw new Error("That passphrase didn't match.");
        });

      setNotice("Your vault passphrase has been changed.");
      setCurrentPass("");
      setNewPass("");
      setConfirmPass("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't change your passphrase.");
    } finally {
      setBusy(false);
    }
  }

  if (loading || !status) {
    return (
      <main className="center">
        <div className="card">
          <BrandHeader />
          <p className="subtle">Loading…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="center">
      <div className="card">
        <BrandHeader />
        <h1>Your account</h1>
        <p className="subtle">Signed in as {status.email}.</p>

        {mode === "confirm-link" && confirmEmail && (
          <form onSubmit={onConfirmLink}>
            <p>
              Link Google account <strong>{confirmEmail}</strong>? Enter your vault passphrase to
              confirm.
            </p>
            <label htmlFor="pp">Vault passphrase</label>
            <input id="pp" type="password" value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)} required />
            <button type="submit" disabled={busy}>{busy ? "Linking…" : "Confirm link"}</button>
          </form>
        )}

        {mode === "unlink" && (
          <form onSubmit={onUnlink}>
            <p>Unlink Google? Enter your vault passphrase to confirm.</p>
            <label htmlFor="pu">Vault passphrase</label>
            <input id="pu" type="password" value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)} required />
            <button type="submit" disabled={busy}>{busy ? "Unlinking…" : "Confirm unlink"}</button>
          </form>
        )}

        {mode === "idle" && (
          <div>
            <p className="subtle">
              Google sign-in: <strong>{status.googleLinked ? "Linked" : "Not linked"}</strong>
            </p>
            {!status.googleLinked && (
              <a className="linkbtn" href="/api/auth/google/start?intent=link">Link Google</a>
            )}
            {status.googleLinked && status.hasPassword && (
              <button type="button" onClick={() => { setNotice(""); setError(""); setMode("unlink"); }}>
                Unlink Google
              </button>
            )}
          </div>
        )}

        <div style={{ marginTop: "1.5rem" }}>
          <h2>Change vault passphrase</h2>
          {!masterKey ? (
            <p className="subtle">
              <a className="linkbtn" href="/unlock">Unlock your vault</a> to change your passphrase.
            </p>
          ) : (
            <form onSubmit={onChangePassphrase}>
              <label htmlFor="cur">Current passphrase</label>
              <input id="cur" type="password" value={currentPass}
                onChange={(e) => setCurrentPass(e.target.value)} required />
              <label htmlFor="new">New passphrase</label>
              <input id="new" type="password" value={newPass}
                onChange={(e) => setNewPass(e.target.value)} required minLength={8} />
              <label htmlFor="cf">Confirm new passphrase</label>
              <input id="cf" type="password" value={confirmPass}
                onChange={(e) => setConfirmPass(e.target.value)} required minLength={8} />
              <button type="submit" disabled={busy}>
                {busy ? "Changing…" : "Change passphrase"}
              </button>
            </form>
          )}
        </div>

        {notice && <p className="subtle">{notice}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </main>
  );
}
