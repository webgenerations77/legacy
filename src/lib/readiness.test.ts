import { describe, it, expect } from "vitest";
import {
  computeReadiness,
  serializeReadinessState,
  parseReadinessState,
  CATEGORY_WEIGHTS,
  type ReadinessInput,
  type ReadinessCategoryKey,
} from "@/lib/readiness";
import type { Account } from "@/lib/account";
import type { Bill } from "@/lib/bill";
import type { Loan } from "@/lib/loan";
import type { Beneficiary } from "@/lib/beneficiary";

const account: Account = {
  type: "Savings",
  institution: "First National",
  nickname: "Rainy day",
  accountNumber: "123456784821",
  balance: "12,500",
  notes: "",
};
const bill: Bill = {
  name: "Electric",
  category: "Utility",
  amount: "100",
  frequency: "Monthly",
  nextDueDate: "2026-07-01",
  paymentMethod: "Visa",
  autoPay: true,
  website: "",
  notes: "",
};
const loan: Loan = {
  kind: "Mortgage",
  lender: "First National",
  nickname: "Home",
  accountNumber: "987654321098",
  originalAmount: "350000",
  currentBalance: "312400",
  interestRate: "6.25",
  monthlyPayment: "2150",
  nextPaymentDate: "2026-07-01",
  payoffDate: "2051-06-01",
  notes: "",
};
function bene(allocation: string): Beneficiary {
  return {
    fullName: "Jane Doe",
    relationship: "Spouse",
    email: "",
    phone: "",
    mailingAddress: "",
    allocation,
    notes: "",
  };
}

const EMPTY: ReadinessInput = {
  accounts: [],
  bills: [],
  loans: [],
  beneficiaries: [],
  vaultCount: 0,
  obituaryDraftPresent: false,
  acknowledgedEmpty: [],
};

function cat(input: ReadinessInput, key: ReadinessCategoryKey) {
  return computeReadiness(input).categories.find((c) => c.key === key)!;
}

describe("computeReadiness", () => {
  it("scores an empty profile at 0 with every category 'empty'", () => {
    const report = computeReadiness(EMPTY);
    expect(report.overall).toBe(0);
    expect(report.completeCount).toBe(0);
    expect(report.categories).toHaveLength(6);
    expect(report.categories.every((c) => c.status === "empty")).toBe(true);
    expect(report.categories.every((c) => c.score === 0)).toBe(true);
  });

  it("scores a fully-populated, balanced profile at 100", () => {
    const report = computeReadiness({
      accounts: [account],
      bills: [bill],
      loans: [loan],
      beneficiaries: [bene("100")],
      vaultCount: 1,
      obituaryDraftPresent: true,
      acknowledgedEmpty: [],
    });
    expect(report.overall).toBe(100);
    expect(report.completeCount).toBe(6);
    expect(report.categories.every((c) => c.status === "complete")).toBe(true);
  });

  it("gives beneficiaries a partial 'attention' score when present but unbalanced", () => {
    const c = cat({ ...EMPTY, beneficiaries: [bene("50")] }, "beneficiaries");
    expect(c.score).toBe(60);
    expect(c.status).toBe("attention");
    expect(c.suggestion).toContain("50%");
  });

  it("awards full beneficiary credit only when allocations balance to 100%", () => {
    const c = cat({ ...EMPTY, beneficiaries: [bene("60"), bene("40")] }, "beneficiaries");
    expect(c.score).toBe(100);
    expect(c.status).toBe("complete");
    expect(c.suggestion).toBeUndefined();
  });

  it("weights each category by importance (only accounts present -> 25)", () => {
    expect(computeReadiness({ ...EMPTY, accounts: [account] }).overall).toBe(25);
    expect(computeReadiness({ ...EMPTY, loans: [loan] }).overall).toBe(15);
    expect(computeReadiness({ ...EMPTY, vaultCount: 1 }).overall).toBe(10);
  });

  it("treats an acknowledged-empty category as complete and lifts the overall", () => {
    const report = computeReadiness({ ...EMPTY, acknowledgedEmpty: ["loans"] });
    const loans = report.categories.find((c) => c.key === "loans")!;
    expect(loans.score).toBe(100);
    expect(loans.status).toBe("complete");
    expect(loans.acknowledged).toBe(true);
    expect(loans.suggestion).toBeUndefined();
    expect(report.overall).toBe(15);
  });

  it("exposes weights that sum to 100", () => {
    const sum = Object.values(CATEGORY_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });
});

describe("readiness state serialization", () => {
  it("round-trips acknowledgedEmpty", () => {
    const state = { acknowledgedEmpty: ["loans", "bills"] as ReadinessCategoryKey[] };
    expect(parseReadinessState(serializeReadinessState(state))).toEqual(state);
  });

  it("returns an empty list on malformed or unknown input", () => {
    expect(parseReadinessState("not json")).toEqual({ acknowledgedEmpty: [] });
    expect(parseReadinessState("{}")).toEqual({ acknowledgedEmpty: [] });
    expect(parseReadinessState('{"acknowledgedEmpty":["loans","bogus"]}')).toEqual({
      acknowledgedEmpty: ["loans"],
    });
  });
});
