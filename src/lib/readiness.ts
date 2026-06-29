import { type Account } from "@/lib/account";
import { type Bill } from "@/lib/bill";
import { type Loan } from "@/lib/loan";
import {
  type Beneficiary,
  totalAllocation,
  allocationStatus,
} from "@/lib/beneficiary";

export type ReadinessCategoryKey =
  | "accounts"
  | "beneficiaries"
  | "loans"
  | "bills"
  | "obituary"
  | "vault";

const ORDER: ReadinessCategoryKey[] = [
  "accounts",
  "beneficiaries",
  "loans",
  "bills",
  "obituary",
  "vault",
];

export const CATEGORY_WEIGHTS: Record<ReadinessCategoryKey, number> = {
  accounts: 25,
  beneficiaries: 25,
  loans: 15,
  bills: 15,
  obituary: 10,
  vault: 10,
};

const CATEGORY_LABELS: Record<ReadinessCategoryKey, string> = {
  accounts: "Accounts",
  beneficiaries: "Beneficiaries",
  loans: "Loans",
  bills: "Bills",
  obituary: "Obituary",
  vault: "Vault",
};

export interface ReadinessState {
  acknowledgedEmpty: ReadinessCategoryKey[];
}

export interface ReadinessInput {
  accounts: Account[];
  bills: Bill[];
  loans: Loan[];
  beneficiaries: Beneficiary[];
  vaultCount: number;
  obituaryDraftPresent: boolean;
  acknowledgedEmpty: ReadinessCategoryKey[];
}

export interface ReadinessCategory {
  key: ReadinessCategoryKey;
  label: string;
  weight: number;
  score: number; // 0-100 sub-score
  status: "complete" | "attention" | "empty";
  acknowledged: boolean;
  suggestion?: string;
}

export interface ReadinessReport {
  overall: number; // 0-100 integer
  completeCount: number;
  categories: ReadinessCategory[];
}

// Present a percentage as a clean string: integers bare, otherwise 2 decimals.
function formatPercent(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// Record-only sub-score (before any "nothing to add" acknowledgment).
function rawScore(key: ReadinessCategoryKey, input: ReadinessInput): number {
  switch (key) {
    case "accounts":
      return input.accounts.length > 0 ? 100 : 0;
    case "beneficiaries": {
      if (input.beneficiaries.length === 0) return 0;
      const balanced =
        allocationStatus(totalAllocation(input.beneficiaries)) === "balanced";
      return balanced ? 100 : 60;
    }
    case "loans":
      return input.loans.length > 0 ? 100 : 0;
    case "bills":
      return input.bills.length > 0 ? 100 : 0;
    case "obituary":
      return input.obituaryDraftPresent ? 100 : 0;
    case "vault":
      return input.vaultCount > 0 ? 100 : 0;
  }
}

function suggestionFor(key: ReadinessCategoryKey, input: ReadinessInput): string {
  switch (key) {
    case "accounts":
      return "Add your financial accounts so survivors know what exists.";
    case "beneficiaries":
      if (input.beneficiaries.length === 0) return "Add at least one beneficiary.";
      return `Allocations total ${formatPercent(
        totalAllocation(input.beneficiaries),
      )}% — adjust to 100%.`;
    case "loans":
      return "Add your loans, or mark 'Nothing to add'.";
    case "bills":
      return "Add your recurring bills, or mark 'Nothing to add'.";
    case "obituary":
      return "Draft an obituary, or mark 'Nothing to add'.";
    case "vault":
      return "Save important notes to your vault, or mark 'Nothing to add'.";
  }
}

export function computeReadiness(input: ReadinessInput): ReadinessReport {
  const ack = new Set(input.acknowledgedEmpty);

  const categories = ORDER.map((key): ReadinessCategory => {
    const acknowledged = ack.has(key);
    const score = acknowledged ? 100 : rawScore(key, input);
    const status: ReadinessCategory["status"] =
      score === 100 ? "complete" : score === 0 ? "empty" : "attention";
    const category: ReadinessCategory = {
      key,
      label: CATEGORY_LABELS[key],
      weight: CATEGORY_WEIGHTS[key],
      score,
      status,
      acknowledged,
    };
    if (score < 100) category.suggestion = suggestionFor(key, input);
    return category;
  });

  const overall = Math.round(
    categories.reduce((sum, c) => sum + (c.weight * c.score) / 100, 0),
  );
  const completeCount = categories.filter((c) => c.score === 100).length;
  return { overall, completeCount, categories };
}

export function serializeReadinessState(state: ReadinessState): string {
  return JSON.stringify(state);
}

export function parseReadinessState(json: string): ReadinessState {
  try {
    const data = JSON.parse(json) as unknown;
    const raw = (data as { acknowledgedEmpty?: unknown }).acknowledgedEmpty;
    if (Array.isArray(raw)) {
      const keys = raw.filter(
        (k): k is ReadinessCategoryKey =>
          typeof k === "string" && (ORDER as string[]).includes(k),
      );
      return { acknowledgedEmpty: keys };
    }
  } catch {
    // fall through to default
  }
  return { acknowledgedEmpty: [] };
}
