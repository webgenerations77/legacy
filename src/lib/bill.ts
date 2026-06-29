export type Frequency = "Weekly" | "Monthly" | "Quarterly" | "Annual" | "One-time";

export type BillCategory =
  | "Utility"
  | "Streaming"
  | "Insurance"
  | "Loan"
  | "Subscription"
  | "Other";

export interface Bill {
  name: string;
  category: BillCategory;
  amount: string;
  frequency: Frequency;
  nextDueDate: string; // "YYYY-MM-DD" or ""
  paymentMethod: string;
  autoPay: boolean;
  website: string;
  notes: string;
}

export function serializeBill(b: Bill): string {
  return JSON.stringify(b);
}

export function parseBill(json: string): Bill {
  return JSON.parse(json) as Bill;
}

// Parse a free-text amount defensively: drop currency symbols, spaces, and
// thousands separators, then parseFloat. Non-numeric / empty -> 0.
function parseAmount(amount: string): number {
  const cleaned = amount.replace(/[^0-9.]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function monthlyAmount(b: Bill): number {
  const value = parseAmount(b.amount);
  switch (b.frequency) {
    case "Weekly":
      return value * 52 / 12;
    case "Monthly":
      return value;
    case "Quarterly":
      return value / 3;
    case "Annual":
      return value / 12;
    case "One-time":
      return 0;
    default:
      return 0;
  }
}

export function totalMonthly(bills: Bill[]): number {
  return bills.reduce((sum, b) => sum + monthlyAmount(b), 0);
}

export function formatMoney(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

export function sortByDueDate(bills: Bill[]): Bill[] {
  return [...bills].sort((a, b) => {
    if (!a.nextDueDate) return b.nextDueDate ? 1 : 0;
    if (!b.nextDueDate) return -1;
    return a.nextDueDate < b.nextDueDate ? -1 : a.nextDueDate > b.nextDueDate ? 1 : 0;
  });
}
