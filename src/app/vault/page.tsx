"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { LegacyMark } from "@/components/Logo";
import { useKey } from "@/app/providers/KeyProvider";
import { encryptItem, decryptItem } from "@/lib/crypto";

export default function VaultPage() {
  const router = useRouter();
  const { masterKey, setMasterKey } = useKey();
  const [items, setItems] = useState<{ id: string; text: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!masterKey) return;
    const { items: raw } = await api.listVault();
    const decrypted = await Promise.all(
      raw.map(async (it) => {
        try {
          return { id: it.id, text: await decryptItem(masterKey, it.ciphertext, it.iv) };
        } catch {
          return { id: it.id, text: "We couldn't unlock this item." };
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
      setError("We couldn't load your vault. Please try unlocking again."),
    );
  }, [masterKey, load, router]);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!masterKey || !draft.trim()) return;
    setError("");
    try {
      const { ciphertext, iv } = await encryptItem(masterKey, draft.trim());
      await api.addVaultItem(ciphertext, iv);
      setDraft("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    }
  }

  async function onLogout() {
    try {
      await api.logout();
    } catch {
      // best-effort: always clear the in-memory key and leave the vault
    }
    setMasterKey(null);
    router.replace("/unlock");
  }

  if (!masterKey) return null;

  return (
    <main className="center">
      <div className="card">
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Your Vault</h1>
        <p className="subtle">Everything here is encrypted on your device.</p>
        <form className="row" onSubmit={onAdd}>
          <input value={draft} placeholder="Add a private note…"
            onChange={(e) => setDraft(e.target.value)} />
          <button type="submit">Add</button>
        </form>
        {error && <p className="error">{error}</p>}
        {loaded && items.length === 0 && <p className="subtle">Nothing yet. Add your first note.</p>}
        {items.map((it) => (
          <div className="item" key={it.id}>{it.text}</div>
        ))}
        <p className="link"><button type="button" className="linkbtn" onClick={onLogout}>Lock &amp; sign out</button></p>
      </div>
    </main>
  );
}
