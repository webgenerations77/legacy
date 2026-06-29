import { describe, it, expect } from "vitest";
import {
  serializeBeneficiary,
  parseBeneficiary,
  totalAllocation,
  allocationStatus,
  sortByAllocationDesc,
  maskContact,
  type Beneficiary,
} from "@/lib/beneficiary";

const sample: Beneficiary = {
  fullName: "Jane Doe",
  relationship: "Spouse",
  email: "jane@example.com",
  phone: "555-123-4567",
  mailingAddress: "12 Oak St, Springfield",
  allocation: "50",
  notes: "Primary beneficiary",
};

function beneficiary(partial: Partial<Beneficiary>): Beneficiary {
  return { ...sample, ...partial };
}

describe("beneficiary domain", () => {
  it("round-trips through serialize/parse, preserving every field", () => {
    expect(parseBeneficiary(serializeBeneficiary(sample))).toEqual(sample);
  });

  it("sums allocations across a mixed set, defensively; 0 for none", () => {
    const set = [
      beneficiary({ allocation: "50" }),
      beneficiary({ allocation: "25.5%" }),
      beneficiary({ allocation: "" }),
      beneficiary({ allocation: "n/a" }),
    ];
    expect(totalAllocation(set)).toBeCloseTo(75.5);
    expect(totalAllocation([])).toBe(0);
  });

  it("classifies allocation totals at the 100% thresholds", () => {
    expect(allocationStatus(99)).toBe("under");
    expect(allocationStatus(100)).toBe("balanced");
    expect(allocationStatus(101)).toBe("over");
  });

  it("sorts by allocation descending, ties broken by name, without mutating input", () => {
    const input = [
      beneficiary({ fullName: "Bob", allocation: "25" }),
      beneficiary({ fullName: "Alice", allocation: "50" }),
      beneficiary({ fullName: "Carol", allocation: "25" }),
    ];
    const sorted = sortByAllocationDesc(input);
    expect(sorted.map((b) => b.fullName)).toEqual(["Alice", "Bob", "Carol"]);
    expect(input.map((b) => b.fullName)).toEqual(["Bob", "Alice", "Carol"]); // input untouched
  });

  it("masks an email to its first letter and domain", () => {
    expect(maskContact("jane@example.com")).toBe("j***@example.com");
  });

  it("masks a phone/other value to the last four characters", () => {
    expect(maskContact("5551234567")).toBe("••••4567");
    expect(maskContact("123")).toBe("123");
    expect(maskContact("")).toBe("");
  });
});
