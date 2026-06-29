"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { useKey } from "@/app/providers/KeyProvider";
import { encryptItem, decryptItem } from "@/lib/crypto";
import {
  type Account,
  type AccountType,
  serializeAccount,
  parseAccount,
  maskAccountNumber,
} from "@/lib/account";

const TYPES: AccountType[] = [
  "Checking",
  "Savings",
  "Investment",
  "Retirement",
  "Other",
];

const EMPTY: Account = {
  type: "Checking",
  institution: "",
  nickname: "",
  accountNumber: "",
  balance: "",
  notes: "",
};

export default function AccountsPage() {
  const router = useRouter();
  const { masterKey } = useKey();
  const [items, setItems] = useState<{ id: string; account: Account | null }[]>([]);
  const [draft, setDraft] = useState<Account>(EMPTY);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!masterKey) return;
    setError("");
    const { accounts } = await api.listAccounts();
    const decrypted = await Promise.all(
      accounts.map(async (a) => {
        try {
          const json = await decryptItem(masterKey, a.ciphertext, a.iv);
          return { id: a.id, account: parseAccount(json) };
        } catch {
          return { id: a.id, account: null };
        }
      }),
    );
    setItems(decrypted);
    setLoaded(true);
  }, [masterKey]);

  useEffect(() => {
    if (!masterKey) {
      router.replace("/unlock");
      return;
    }
    load().catch(() =>
      setError("We couldn't load your accounts. Please try unlocking again."),
    );
  }, [masterKey, load, router]);

  function set<K extends keyof Account>(key: K, value: Account[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!masterKey || !draft.nickname.trim()) return;
    setError("");
    try {
      const { ciphertext, iv } = await encryptItem(masterKey, serializeAccount(draft));
      await api.addAccount(ciphertext, iv);
      setDraft(EMPTY);
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "We couldn't save that. Please try again.",
      );
    }
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
            {it.account ? (
              <>
                <strong>{it.account.nickname || "Untitled account"}</strong>
                <div className="meta">
                  {it.account.type}
                  {it.account.institution ? ` · ${it.account.institution}` : ""}
                </div>
                {it.account.accountNumber && (
                  <div className="meta">{maskAccountNumber(it.account.accountNumber)}</div>
                )}
                {it.account.balance && <div className="meta">Balance: {it.account.balance}</div>}
                {it.account.notes && <div className="notes">{it.account.notes}</div>}
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
