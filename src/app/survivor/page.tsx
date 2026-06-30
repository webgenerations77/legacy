"use client";

import { useEffect, useState } from "react";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { useKey } from "@/app/providers/KeyProvider";
import { api } from "@/lib/api-client";
import { buildSurvivorEscrow } from "@/lib/survivor-crypto";

type Status = { armed: boolean; updatedAt: string | null } | null;

export default function SurvivorPage() {
  const { masterKey } = useKey();
  const [status, setStatus] = useState<Status>(null);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.survivorStatus().then(setStatus).catch(() => setError("Couldn't load status."));
  }, []);

  if (!masterKey) return null;

  async function arm() {
    setBusy(true);
    setError("");
    try {
      const result = await buildSurvivorEscrow(masterKey!);
      await api.armSurvivor({
        survivorSalt: result.survivorSalt,
        survivorAuthVerifier: result.survivorAuthVerifier,
        escrowCiphertext: result.escrowCiphertext,
        escrowIv: result.escrowIv,
      });
      setCode(result.recoveryCode);
      setStatus({ armed: true, updatedAt: new Date().toISOString() });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    setError("");
    try {
      await api.revokeSurvivor();
      setStatus({ armed: false, updatedAt: null });
      setCode(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Survivor access</h1>
        <p className="subtle">
          Generate a one-time recovery code and store it somewhere safe — with your lawyer,
          in a sealed letter, or a safe. Anyone who has it can unlock a read-only copy of your
          vault. We can never show the code again, and we never see it.
        </p>

        {code && (
          <div className="item" style={{ textAlign: "center" }}>
            <strong>Your recovery code</strong>
            <div className="notes" style={{ fontSize: "1.25rem", letterSpacing: "0.1em" }}>
              {code}
            </div>
            <p className="error">
              Save this now. It will not be shown again, and it cannot be recovered.
            </p>
            <button type="button" onClick={() => navigator.clipboard?.writeText(code)}>
              Copy code
            </button>
            <button type="button" onClick={() => window.print()}>
              Print
            </button>
          </div>
        )}

        {status?.armed ? (
          <>
            <p className="subtle">
              Survivor access is armed
              {status.updatedAt ? ` (since ${new Date(status.updatedAt).toLocaleDateString()})` : ""}.
            </p>
            <button type="button" onClick={arm} disabled={busy}>
              {busy ? "Working…" : "Regenerate code"}
            </button>
            <p className="subtle">Regenerating immediately invalidates the previous code.</p>
            <button type="button" className="linkbtn" onClick={revoke} disabled={busy}>
              Remove survivor access
            </button>
          </>
        ) : (
          <button type="button" onClick={arm} disabled={busy}>
            {busy ? "Working…" : "Set up survivor access"}
          </button>
        )}

        {error && <p className="error">{error}</p>}
      </div>
    </main>
  );
}
