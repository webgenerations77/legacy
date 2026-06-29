import { describe, it, expect } from "vitest";
import {
  serializeBill,
  parseBill,
  monthlyAmount,
  totalMonthly,
  formatMoney,
  sortByDueDate,
  type Bill,
} from "@/lib/bill";

const sample: Bill = {
  name: "Netflix",
  category: "Streaming",
  amount: "15.99",
  frequency: "Monthly",
  nextDueDate: "2026-07-04",
  paymentMethod: "Visa ••1234",
  autoPay: true,
  website: "netflix.com/account",
  notes: "Family plan",
};

function bill(partial: Partial<Bill>): Bill {
  return { ...sample, ...partial };
}

describe("bill domain", () => {
  it("round-trips through serialize/parse, preserving the autoPay boolean", () => {
    const back = parseBill(serializeBill(sample));
    expect(back).toEqual(sample);
    expect(back.autoPay).toBe(true);
  });

  it("normalizes each frequency to a monthly amount", () => {
    expect(monthlyAmount(bill({ amount: "12", frequency: "Monthly" }))).toBeCloseTo(12);
    expect(monthlyAmount(bill({ amount: "120", frequency: "Annual" }))).toBeCloseTo(10);
    expect(monthlyAmount(bill({ amount: "30", frequency: "Quarterly" }))).toBeCloseTo(10);
    expect(monthlyAmount(bill({ amount: "10", frequency: "Weekly" }))).toBeCloseTo(10 * 52 / 12);
    expect(monthlyAmount(bill({ amount: "500", frequency: "One-time" }))).toBe(0);
  });

  it("treats non-numeric or messy amounts defensively", () => {
    expect(monthlyAmount(bill({ amount: "", frequency: "Monthly" }))).toBe(0);
    expect(monthlyAmount(bill({ amount: "free", frequency: "Monthly" }))).toBe(0);
    expect(monthlyAmount(bill({ amount: "$1,200", frequency: "Annual" }))).toBeCloseTo(100);
  });

  it("sums monthly amounts across a mixed set, and is 0 for none", () => {
    const bills = [
      bill({ amount: "12", frequency: "Monthly" }),
      bill({ amount: "120", frequency: "Annual" }),
      bill({ amount: "999", frequency: "One-time" }),
    ];
    expect(totalMonthly(bills)).toBeCloseTo(22);
    expect(totalMonthly([])).toBe(0);
  });

  it("formats money to a whole dollar", () => {
    expect(formatMoney(247.4)).toBe("$247");
    expect(formatMoney(0)).toBe("$0");
  });

  it("sorts by due date ascending with blanks last, without mutating input", () => {
    const input = [
      bill({ name: "C", nextDueDate: "" }),
      bill({ name: "A", nextDueDate: "2026-07-01" }),
      bill({ name: "B", nextDueDate: "2026-08-15" }),
    ];
    const sorted = sortByDueDate(input);
    expect(sorted.map((b) => b.name)).toEqual(["A", "B", "C"]);
    expect(input.map((b) => b.name)).toEqual(["C", "A", "B"]); // input untouched
  });
});
