"use client";

import { useState } from "react";
import { BrandHeader } from "@/components/Logo";
import { api, type SurvivorRecords } from "@/lib/api-client";
import { deriveSurvivorAuthVerifier, recoverMasterKey } from "@/lib/survivor-crypto";
import { decryptItem, type CryptoBytes } from "@/lib/crypto";
import { parseAccount, type Account } from "@/lib/account";
import { parseBill, type Bill } from "@/lib/bill";
import { parseLoan, type Loan } from "@/lib/loan";
import { parseBeneficiary, type Beneficiary } from "@/lib/beneficiary";

type Decrypted = {
  accounts: Account[];
  bills: Bill[];
  loans: Loan[];
  beneficiaries: Beneficiary[];
  notes: string[];
  obituary: string | null;
};

async function decryptAll(mk: CryptoBytes, records: SurvivorRecords): Promise<Decrypted> {
  const tryParse = async <T,>(
    rows: { ciphertext: string; iv: string }[],
    parse: (json: string) => T,
  ): Promise<T[]> => {
    const out: T[] = [];
    for (const r of rows) {
      try {
        out.push(parse(await decryptItem(mk, r.ciphertext, r.iv)));
      } catch {
        // skip any record that fails to decrypt
      }
    }
    return out;
  };
  const notes: string[] = [];
  for (const r of records.items) {
    try {
      notes.push(await decryptItem(mk, r.ciphertext, r.iv));
    } catch {
      // skip
    }
  }
  return {
    accounts: await tryParse(records.accounts, parseAccount),
    bills: await tryParse(records.bills, parseBill),
    loans: await tryParse(records.loans, parseLoan),
    beneficiaries: await tryParse(records.beneficiaries, parseBeneficiary),
    notes,
    obituary: records.obituary?.draft ?? null,
  };
}

export default function RecoverPage() {
  const [email, setEmail] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<Decrypted | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { salt } = await api.survivorSalt(email);
      const verifier = await deriveSurvivorAuthVerifier(recoveryCode, salt);
      const claim = await api.survivorClaim(email, verifier).catch(() => {
        throw new Error("That email or recovery code didn't match.");
      });
      const mk = await recoverMasterKey(
        recoveryCode,
        salt,
        claim.escrow.ciphertext,
        claim.escrow.iv,
      );
      setData(await decryptAll(mk, claim.records));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "legacy-records.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (data) {
    return (
      <main className="center">
        <div className="card">
          <BrandHeader />
          <h1>Their Legacy</h1>
          <p className="subtle">Read-only. Nothing here is stored on this device.</p>
          <div className="no-print">
            <button type="button" onClick={() => window.print()}>Print</button>
            <button type="button" onClick={download}>Download</button>
          </div>

          {data.notes.length > 0 && (
            <section>
              <h2>Notes</h2>
              {data.notes.map((n, i) => (
                <div className="item" key={i}><div className="notes">{n}</div></div>
              ))}
            </section>
          )}

          {data.accounts.length > 0 && (
            <section>
              <h2>Accounts</h2>
              {data.accounts.map((a, i) => (
                <div className="item" key={i}>
                  <strong>{a.institution} — {a.nickname}</strong>
                  <div className="meta">{a.type} · {a.accountNumber} · {a.balance}</div>
                  {a.notes && <div className="notes">{a.notes}</div>}
                </div>
              ))}
            </section>
          )}

          {data.bills.length > 0 && (
            <section>
              <h2>Bills</h2>
              {data.bills.map((b, i) => (
                <div className="item" key={i}>
                  <strong>{b.name}</strong>
                  <div className="meta">{b.category} · {b.amount} · {b.frequency} · due {b.nextDueDate}</div>
                  {b.notes && <div className="notes">{b.notes}</div>}
                </div>
              ))}
            </section>
          )}

          {data.loans.length > 0 && (
            <section>
              <h2>Loans</h2>
              {data.loans.map((l, i) => (
                <div className="item" key={i}>
                  <strong>{l.lender} — {l.nickname}</strong>
                  <div className="meta">{l.kind} · balance {l.currentBalance} · {l.interestRate}</div>
                  {l.notes && <div className="notes">{l.notes}</div>}
                </div>
              ))}
            </section>
          )}

          {data.beneficiaries.length > 0 && (
            <section>
              <h2>Beneficiaries</h2>
              {data.beneficiaries.map((b, i) => (
                <div className="item" key={i}>
                  <strong>{b.fullName}</strong>
                  <div className="meta">{b.relationship}{b.allocation ? ` · ${b.allocation}%` : ""}</div>
                  {b.email && <div className="meta">{b.email}</div>}
                  {b.phone && <div className="meta">{b.phone}</div>}
                  {b.mailingAddress && <div className="meta">{b.mailingAddress}</div>}
                  {b.notes && <div className="notes">{b.notes}</div>}
                </div>
              ))}
            </section>
          )}

          {data.obituary && (
            <section>
              <h2>Obituary</h2>
              <div className="item"><div className="notes">{data.obituary}</div></div>
            </section>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="center">
      <form className="card" onSubmit={onSubmit}>
        <BrandHeader />
        <h1>Access a loved one&apos;s Legacy</h1>
        <p className="subtle">
          Enter their email and the recovery code they left you. You&apos;ll see a read-only
          copy of what they saved.
        </p>
        <label htmlFor="email">Their email</label>
        <input id="email" type="email" value={email}
          onChange={(e) => setEmail(e.target.value)} required />
        <label htmlFor="code">Recovery code</label>
        <input id="code" value={recoveryCode}
          onChange={(e) => setRecoveryCode(e.target.value)} required />
        <button type="submit" disabled={busy}>
          {busy ? "Unlocking…" : "Unlock"}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </main>
  );
}
