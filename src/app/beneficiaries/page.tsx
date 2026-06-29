"use client";

import { useState } from "react";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { useEncryptedRecords } from "@/app/providers/useEncryptedRecords";
import {
  type Beneficiary,
  type BeneficiaryRelationship,
  serializeBeneficiary,
  parseBeneficiary,
  totalAllocation,
  allocationStatus,
  sortByAllocationDesc,
  maskContact,
} from "@/lib/beneficiary";

const RELATIONSHIPS: BeneficiaryRelationship[] = [
  "Spouse",
  "Child",
  "Parent",
  "Sibling",
  "Friend",
  "Trust",
  "Charity",
  "Other",
];

const EMPTY: Beneficiary = {
  fullName: "",
  relationship: "Spouse",
  email: "",
  phone: "",
  mailingAddress: "",
  allocation: "",
  notes: "",
};

const pct = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export default function BeneficiariesPage() {
  const { items, error, loaded, add, masterKey } = useEncryptedRecords<Beneficiary>({
    resource: "beneficiaries",
    listKey: "beneficiaries",
    serialize: serializeBeneficiary,
    parse: parseBeneficiary,
    noun: "beneficiaries",
  });
  const [draft, setDraft] = useState<Beneficiary>(EMPTY);

  function set<K extends keyof Beneficiary>(key: K, value: Beneficiary[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.fullName.trim()) return;
    if (await add(draft)) setDraft(EMPTY);
  }

  if (!masterKey) return null;

  const decrypted = items
    .map((it) => it.value)
    .filter((b): b is Beneficiary => b !== null);
  const sorted = sortByAllocationDesc(decrypted);
  const total = totalAllocation(decrypted);
  const status = allocationStatus(total);

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Beneficiaries</h1>
        <p className="subtle">Each beneficiary is encrypted on your device.</p>

        <form onSubmit={onAdd}>
          <label htmlFor="fullName">Full name</label>
          <input
            id="fullName"
            value={draft.fullName}
            onChange={(e) => set("fullName", e.target.value)}
          />

          <label htmlFor="relationship">Relationship</label>
          <select
            id="relationship"
            value={draft.relationship}
            onChange={(e) => set("relationship", e.target.value as BeneficiaryRelationship)}
          >
            {RELATIONSHIPS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>

          <label htmlFor="email">Email</label>
          <input
            id="email"
            value={draft.email}
            onChange={(e) => set("email", e.target.value)}
          />

          <label htmlFor="phone">Phone</label>
          <input
            id="phone"
            value={draft.phone}
            onChange={(e) => set("phone", e.target.value)}
          />

          <label htmlFor="mailingAddress">Mailing address</label>
          <input
            id="mailingAddress"
            value={draft.mailingAddress}
            onChange={(e) => set("mailingAddress", e.target.value)}
          />

          <label htmlFor="allocation">Allocation (%)</label>
          <input
            id="allocation"
            value={draft.allocation}
            onChange={(e) => set("allocation", e.target.value)}
          />

          <label htmlFor="notes">Notes</label>
          <textarea
            id="notes"
            value={draft.notes}
            onChange={(e) => set("notes", e.target.value)}
          />

          <button type="submit">Add beneficiary</button>
        </form>

        {error && <p className="error">{error}</p>}

        {decrypted.length > 0 && (
          <p className="subtle">
            {status === "balanced"
              ? `Allocated: 100% across ${decrypted.length} ${
                  decrypted.length === 1 ? "beneficiary" : "beneficiaries"
                }`
              : status === "under"
                ? `Allocated: ${pct(total)}% — ${pct(100 - total)}% unassigned`
                : `Over-allocated by ${pct(total - 100)}%`}
          </p>
        )}

        {loaded && items.length === 0 && (
          <p className="subtle">No beneficiaries yet. Add your first above.</p>
        )}

        {items.some((it) => it.value === null) && (
          <p className="subtle">We couldn&apos;t unlock some beneficiaries.</p>
        )}

        {sorted.map((b, i) => (
          <div className="item" key={i}>
            <strong>{b.fullName || "Unnamed beneficiary"}</strong>
            <div className="meta">
              {b.relationship}
              {b.allocation ? ` · ${b.allocation}%` : ""}
            </div>
            {b.email && <div className="meta">{maskContact(b.email)}</div>}
            {b.phone && <div className="meta">{maskContact(b.phone)}</div>}
            {b.mailingAddress && <div className="meta">{b.mailingAddress}</div>}
            {b.notes && <div className="notes">{b.notes}</div>}
          </div>
        ))}
      </div>
    </main>
  );
}
