import { describe, it, expect } from "vitest";
import {
  serializeLoan,
  parseLoan,
  totalBalance,
  totalMonthly,
  formatMoney,
  sortByNextPaymentDate,
  maskAccountNumber,
  type Loan,
} from "@/lib/loan";

const sample: Loan = {
  kind: "Mortgage",
  lender: "First National Bank",
  nickname: "Home",
  accountNumber: "987654321098",
  originalAmount: "350,000",
  currentBalance: "$312,400",
  interestRate: "6.25%",
  monthlyPayment: "2,150",
  nextPaymentDate: "2026-07-01",
  payoffDate: "2051-06-01",
  notes: "30-year fixed",
};

function loan(partial: Partial<Loan>): Loan {
  return { ...sample, ...partial };
}

describe("loan domain", () => {
  it("round-trips through serialize/parse, preserving every field", () => {
    expect(parseLoan(serializeLoan(sample))).toEqual(sample);
  });

  it("sums current balances across a mixed set, defensively; 0 for none", () => {
    const loans = [
      loan({ currentBalance: "$312,400" }),
      loan({ currentBalance: "18,000" }),
      loan({ currentBalance: "" }),
      loan({ currentBalance: "n/a" }),
    ];
    expect(totalBalance(loans)).toBeCloseTo(330400);
    expect(totalBalance([])).toBe(0);
  });

  it("sums monthly payments across a mixed set, defensively; 0 for none", () => {
    const loans = [
      loan({ monthlyPayment: "2,150" }),
      loan({ monthlyPayment: "$450.50" }),
      loan({ monthlyPayment: "" }),
    ];
    expect(totalMonthly(loans)).toBeCloseTo(2600.5);
    expect(totalMonthly([])).toBe(0);
  });

  it("formats money to a whole dollar with thousands separators", () => {
    expect(formatMoney(330400)).toBe("$330,400");
    expect(formatMoney(0)).toBe("$0");
    expect(formatMoney(2150.4)).toBe("$2,150");
  });

  it("sorts by next payment date ascending with blanks last, without mutating input", () => {
    const input = [
      loan({ nickname: "C", nextPaymentDate: "" }),
      loan({ nickname: "A", nextPaymentDate: "2026-07-01" }),
      loan({ nickname: "B", nextPaymentDate: "2026-08-15" }),
    ];
    const sorted = sortByNextPaymentDate(input);
    expect(sorted.map((l) => l.nickname)).toEqual(["A", "B", "C"]);
    expect(input.map((l) => l.nickname)).toEqual(["C", "A", "B"]); // input untouched
  });

  it("masks an account number to the last four digits", () => {
    expect(maskAccountNumber("987654321098")).toBe("••••1098");
    expect(maskAccountNumber("1098")).toBe("1098");
    expect(maskAccountNumber("")).toBe("");
  });
});
