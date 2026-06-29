"use client";

import { useState } from "react";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { useEncryptedRecords } from "@/app/providers/useEncryptedRecords";
import {
  type Account,
  type AccountType,
  serializeAccount,
  parseAccount,
  maskAccountNumber,
} from "@/lib/account";

const TYPES: AccountType[] = ["Checking", "Savings", "Investment", "Retirement", "Other"];

const EMPTY: Account = {
  type: "Checking",
  institution: "",
  nickname: "",
  accountNumber: "",
  balance: "",
  notes: "",
};

export default function AccountsPage() {
  const { items, error, loaded, add, masterKey } = useEncryptedRecords<Account>({
    resource: "accounts",
    listKey: "accounts",
    serialize: serializeAccount,
    parse: parseAccount,
    noun: "accounts",
  });
  const [draft, setDraft] = useState<Account>(EMPTY);

  function set<K extends keyof Account>(key: K, value: Account[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.nickname.trim()) return;
    if (await add(draft)) setDraft(EMPTY);
  }

  if (!masterKey) return null;

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Financial Accounts</h1>
        <p className="subtle">Each account is encrypted on your device.</p>

        <form onSubmit={onAdd}>
          <label htmlFor="type">Type</label>
          <select
            id="type"
            value={draft.type}
            onChange={(e) => set("type", e.target.value as AccountType)}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <label htmlFor="institution">Institution</label>
          <input
            id="institution"
            value={draft.institution}
            onChange={(e) => set("institution", e.target.value)}
          />

          <label htmlFor="nickname">Nickname</label>
          <input
            id="nickname"
            value={draft.nickname}
            onChange={(e) => set("nickname", e.target.value)}
            required
          />

          <label htmlFor="accountNumber">Account number</label>
          <input
            id="accountNumber"
            value={draft.accountNumber}
            onChange={(e) => set("accountNumber", e.target.value)}
          />

          <label htmlFor="balance">Approx. balance</label>
          <input
            id="balance"
            value={draft.balance}
            onChange={(e) => set("balance", e.target.value)}
          />

          <label htmlFor="notes">Notes</label>
          <textarea
            id="notes"
            value={draft.notes}
            onChange={(e) => set("notes", e.target.value)}
          />

          <button type="submit">Add account</button>
        </form>

        {error && <p className="error">{error}</p>}
        {loaded && items.length === 0 && (
          <p className="subtle">No accounts yet. Add your first above.</p>
        )}
        {items.map((it) => (
          <div className="item" key={it.id}>
            {it.value ? (
              <>
                <strong>{it.value.nickname || "Untitled account"}</strong>
                <div className="meta">
                  {it.value.type}
                  {it.value.institution ? ` · ${it.value.institution}` : ""}
                </div>
                {it.value.accountNumber && (
                  <div className="meta">{maskAccountNumber(it.value.accountNumber)}</div>
                )}
                {it.value.balance && <div className="meta">Balance: {it.value.balance}</div>}
                {it.value.notes && <div className="notes">{it.value.notes}</div>}
              </>
            ) : (
              "We couldn't unlock this account."
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
