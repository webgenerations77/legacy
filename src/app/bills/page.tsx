"use client";

import { useState } from "react";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { useEncryptedRecords } from "@/app/providers/useEncryptedRecords";
import { RecordActions } from "@/components/RecordActions";
import {
  type Bill,
  type Frequency,
  type BillCategory,
  serializeBill,
  parseBill,
  totalMonthly,
  formatMoney,
  sortByDueDate,
} from "@/lib/bill";

const CATEGORIES: BillCategory[] = [
  "Utility",
  "Streaming",
  "Insurance",
  "Loan",
  "Subscription",
  "Other",
];

const FREQUENCIES: Frequency[] = ["Weekly", "Monthly", "Quarterly", "Annual", "One-time"];

const EMPTY: Bill = {
  name: "",
  category: "Utility",
  amount: "",
  frequency: "Monthly",
  nextDueDate: "",
  paymentMethod: "",
  autoPay: false,
  website: "",
  notes: "",
};

export default function BillsPage() {
  const { items, error, loaded, add, remove, masterKey } = useEncryptedRecords<Bill>({
    resource: "bills",
    listKey: "bills",
    serialize: serializeBill,
    parse: parseBill,
    noun: "bills",
  });
  const [draft, setDraft] = useState<Bill>(EMPTY);

  function set<K extends keyof Bill>(key: K, value: Bill[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.name.trim()) return;
    if (await add(draft)) setDraft(EMPTY);
  }

  if (!masterKey) return null;

  const decryptedBills = items
    .map((it) => it.value)
    .filter((b): b is Bill => b !== null);
  const sorted = sortByDueDate(decryptedBills);

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Bills &amp; Subscriptions</h1>
        <p className="subtle">Each bill is encrypted on your device.</p>

        <form onSubmit={onAdd}>
          <label htmlFor="name">Name</label>
          <input
            id="name"
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            required
          />

          <label htmlFor="category">Category</label>
          <select
            id="category"
            value={draft.category}
            onChange={(e) => set("category", e.target.value as BillCategory)}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <label htmlFor="amount">Amount</label>
          <input
            id="amount"
            value={draft.amount}
            onChange={(e) => set("amount", e.target.value)}
          />

          <label htmlFor="frequency">Frequency</label>
          <select
            id="frequency"
            value={draft.frequency}
            onChange={(e) => set("frequency", e.target.value as Frequency)}
          >
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>

          <label htmlFor="nextDueDate">Next due date</label>
          <input
            id="nextDueDate"
            type="date"
            value={draft.nextDueDate}
            onChange={(e) => set("nextDueDate", e.target.value)}
          />

          <label htmlFor="paymentMethod">Payment method</label>
          <input
            id="paymentMethod"
            value={draft.paymentMethod}
            onChange={(e) => set("paymentMethod", e.target.value)}
          />

          <label className="checkrow">
            <input
              type="checkbox"
              checked={draft.autoPay}
              onChange={(e) => set("autoPay", e.target.checked)}
            />
            Auto-pay
          </label>

          <label htmlFor="website">Website</label>
          <input
            id="website"
            value={draft.website}
            onChange={(e) => set("website", e.target.value)}
          />

          <label htmlFor="notes">Notes</label>
          <textarea
            id="notes"
            value={draft.notes}
            onChange={(e) => set("notes", e.target.value)}
          />

          <button type="submit">Add bill</button>
        </form>

        {error && <p className="error">{error}</p>}

        {decryptedBills.length > 0 && (
          <p className="subtle">
            Estimated ~{formatMoney(totalMonthly(decryptedBills))}/mo across{" "}
            {decryptedBills.length} {decryptedBills.length === 1 ? "bill" : "bills"}
          </p>
        )}

        {loaded && items.length === 0 && (
          <p className="subtle">No bills yet. Add your first above.</p>
        )}

        {items.some((it) => it.value === null) && (
          <p className="subtle">We couldn&apos;t unlock some bills.</p>
        )}

        {sorted.map((b, i) => {
          const itemId = items.find((it) => it.value === b)?.id ?? "";
          return (
            <div className="item" key={itemId || i}>
              <strong>{b.name || "Untitled bill"}</strong>
              <div className="meta">
                {b.category} · {b.frequency}
                {b.nextDueDate ? ` · due ${b.nextDueDate}` : ""}
              </div>
              {b.amount && <div className="meta">Amount: {b.amount}</div>}
              {b.autoPay && <div className="meta">Auto-pay</div>}
              {b.paymentMethod && <div className="meta">{b.paymentMethod}</div>}
              {b.website && <div className="meta">{b.website}</div>}
              {b.notes && <div className="notes">{b.notes}</div>}
              <RecordActions resource="bills" id={itemId} onDelete={() => remove(itemId)} />
            </div>
          );
        })}
      </div>
    </main>
  );
}
