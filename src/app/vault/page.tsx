"use client";

import { useState } from "react";
import { LegacyMark } from "@/components/Logo";
import { AppNav } from "@/components/AppNav";
import { useEncryptedRecords } from "@/app/providers/useEncryptedRecords";

export default function VaultPage() {
  const { items, error, loaded, add, masterKey } = useEncryptedRecords<string>({
    resource: "vault",
    listKey: "items",
    serialize: (s) => s,
    parse: (s) => s,
    noun: "vault",
    saveError: "Could not save.",
  });
  const [draft, setDraft] = useState("");

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    if (await add(draft.trim())) setDraft("");
  }

  if (!masterKey) return null;

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Your Vault</h1>
        <p className="subtle">Everything here is encrypted on your device.</p>
        <form className="row" onSubmit={onAdd}>
          <input
            value={draft}
            placeholder="Add a private note…"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit">Add</button>
        </form>
        {error && <p className="error">{error}</p>}
        {loaded && items.length === 0 && (
          <p className="subtle">Nothing yet. Add your first note.</p>
        )}
        {items.map((it) => (
          <div className="item" key={it.id}>
            {it.value ?? "We couldn't unlock this item."}
          </div>
        ))}
      </div>
    </main>
  );
}
