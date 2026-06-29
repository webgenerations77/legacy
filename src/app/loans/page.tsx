"use client";

import { useState } from "react";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { useEncryptedRecords } from "@/app/providers/useEncryptedRecords";
import {
  type Loan,
  type LoanKind,
  serializeLoan,
  parseLoan,
  totalBalance,
  totalMonthly,
  formatMoney,
  sortByNextPaymentDate,
  maskAccountNumber,
} from "@/lib/loan";

const KINDS: LoanKind[] = ["Mortgage", "Auto", "Student", "Personal", "HELOC", "Other"];

const EMPTY: Loan = {
  kind: "Mortgage",
  lender: "",
  nickname: "",
  accountNumber: "",
  originalAmount: "",
  currentBalance: "",
  interestRate: "",
  monthlyPayment: "",
  nextPaymentDate: "",
  payoffDate: "",
  notes: "",
};

export default function LoansPage() {
  const { items, error, loaded, add, masterKey } = useEncryptedRecords<Loan>({
    resource: "loans",
    listKey: "loans",
    serialize: serializeLoan,
    parse: parseLoan,
    noun: "loans",
  });
  const [draft, setDraft] = useState<Loan>(EMPTY);

  function set<K extends keyof Loan>(key: K, value: Loan[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.lender.trim() && !draft.nickname.trim()) return;
    if (await add(draft)) setDraft(EMPTY);
  }

  if (!masterKey) return null;

  const decryptedLoans = items
    .map((it) => it.value)
    .filter((l): l is Loan => l !== null);
  const sorted = sortByNextPaymentDate(decryptedLoans);

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Loans &amp; Mortgages</h1>
        <p className="subtle">Each loan is encrypted on your device.</p>

        <form onSubmit={onAdd}>
          <label htmlFor="kind">Type</label>
          <select
            id="kind"
            value={draft.kind}
            onChange={(e) => set("kind", e.target.value as LoanKind)}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>

          <label htmlFor="lender">Lender</label>
          <input
            id="lender"
            value={draft.lender}
            onChange={(e) => set("lender", e.target.value)}
          />

          <label htmlFor="nickname">Nickname</label>
          <input
            id="nickname"
            value={draft.nickname}
            onChange={(e) => set("nickname", e.target.value)}
          />

          <label htmlFor="accountNumber">Account number</label>
          <input
            id="accountNumber"
            value={draft.accountNumber}
            onChange={(e) => set("accountNumber", e.target.value)}
          />

          <label htmlFor="originalAmount">Original amount</label>
          <input
            id="originalAmount"
            value={draft.originalAmount}
            onChange={(e) => set("originalAmount", e.target.value)}
          />

          <label htmlFor="currentBalance">Current balance</label>
          <input
            id="currentBalance"
            value={draft.currentBalance}
            onChange={(e) => set("currentBalance", e.target.value)}
          />

          <label htmlFor="interestRate">Interest rate (APR)</label>
          <input
            id="interestRate"
            value={draft.interestRate}
            onChange={(e) => set("interestRate", e.target.value)}
          />

          <label htmlFor="monthlyPayment">Monthly payment</label>
          <input
            id="monthlyPayment"
            value={draft.monthlyPayment}
            onChange={(e) => set("monthlyPayment", e.target.value)}
          />

          <label htmlFor="nextPaymentDate">Next payment date</label>
          <input
            id="nextPaymentDate"
            type="date"
            value={draft.nextPaymentDate}
            onChange={(e) => set("nextPaymentDate", e.target.value)}
          />

          <label htmlFor="payoffDate">Payoff date</label>
          <input
            id="payoffDate"
            type="date"
            value={draft.payoffDate}
            onChange={(e) => set("payoffDate", e.target.value)}
          />

          <label htmlFor="notes">Notes</label>
          <textarea
            id="notes"
            value={draft.notes}
            onChange={(e) => set("notes", e.target.value)}
          />

          <button type="submit">Add loan</button>
        </form>

        {error && <p className="error">{error}</p>}

        {decryptedLoans.length > 0 && (
          <p className="subtle">
            ~{formatMoney(totalBalance(decryptedLoans))} owed across{" "}
            {decryptedLoans.length} {decryptedLoans.length === 1 ? "loan" : "loans"} ·
            ~{formatMoney(totalMonthly(decryptedLoans))}/mo in payments
          </p>
        )}

        {loaded && items.length === 0 && (
          <p className="subtle">No loans yet. Add your first above.</p>
        )}

        {items.some((it) => it.value === null) && (
          <p className="subtle">We couldn&apos;t unlock some loans.</p>
        )}

        {sorted.map((l, i) => (
          <div className="item" key={i}>
            <strong>{l.nickname || l.lender || "Untitled loan"}</strong>
            <div className="meta">
              {l.kind}
              {l.lender ? ` · ${l.lender}` : ""}
            </div>
            {l.accountNumber && (
              <div className="meta">{maskAccountNumber(l.accountNumber)}</div>
            )}
            {l.currentBalance && <div className="meta">Balance: {l.currentBalance}</div>}
            {l.interestRate && <div className="meta">Rate: {l.interestRate}</div>}
            {l.monthlyPayment && <div className="meta">Payment: {l.monthlyPayment}/mo</div>}
            {l.nextPaymentDate && <div className="meta">Next: {l.nextPaymentDate}</div>}
            {l.payoffDate && <div className="meta">Payoff: {l.payoffDate}</div>}
            {l.notes && <div className="notes">{l.notes}</div>}
          </div>
        ))}
      </div>
    </main>
  );
}
