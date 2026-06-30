import { describe, it, expect } from "vitest";
import {
  buildReadinessDigest,
  serializeRecordsForModel,
} from "@/lib/assistant/records-digest";
import { computeReadiness } from "@/lib/readiness";

describe("buildReadinessDigest", () => {
  const report = computeReadiness({
    accounts: [
      { type: "Checking", institution: "Chase", nickname: "", accountNumber: "", balance: "100", notes: "" },
    ],
    bills: [],
    loans: [],
    beneficiaries: [],
    vaultCount: 0,
    obituaryDraftPresent: false,
    acknowledgedEmpty: [],
  });

  it("projects the report to overall + contents-free categories", () => {
    const digest = buildReadinessDigest(report);
    expect(digest.overall).toBe(report.overall);
    const accounts = digest.categories.find((c) => c.key === "accounts")!;
    expect(accounts.status).toBe("complete");
    const loans = digest.categories.find((c) => c.key === "loans")!;
    expect(loans.status).toBe("empty");
    expect(loans.suggestion).toBeTruthy();
  });

  it("carries no record contents (only key/label/status/suggestion fields)", () => {
    const digest = buildReadinessDigest(report);
    for (const c of digest.categories) {
      expect(Object.keys(c).sort()).toEqual(
        c.suggestion
          ? ["key", "label", "status", "suggestion"].sort()
          : ["key", "label", "status"].sort(),
      );
    }
  });
});

describe("serializeRecordsForModel", () => {
  it("packages records with their type label and count", () => {
    const out = serializeRecordsForModel("loan", [
      { lender: "Wells Fargo", currentBalance: "280000" },
    ]);
    expect(out).toEqual({
      type: "loan",
      label: "Loan or mortgage",
      count: 1,
      records: [{ lender: "Wells Fargo", currentBalance: "280000" }],
    });
  });

  it("reports count 0 for an empty category", () => {
    expect(serializeRecordsForModel("bill", []).count).toBe(0);
  });
});
