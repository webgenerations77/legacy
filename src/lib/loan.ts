export type LoanKind =
  | "Mortgage"
  | "Auto"
  | "Student"
  | "Personal"
  | "HELOC"
  | "Other";

export interface Loan {
  kind: LoanKind;
  lender: string;
  nickname: string;
  accountNumber: string;
  originalAmount: string;
  currentBalance: string;
  interestRate: string;
  monthlyPayment: string;
  nextPaymentDate: string; // "YYYY-MM-DD" or ""
  payoffDate: string; // "YYYY-MM-DD" or ""
  notes: string;
}

export function serializeLoan(l: Loan): string {
  return JSON.stringify(l);
}

export function parseLoan(json: string): Loan {
  return JSON.parse(json) as Loan;
}

// Parse a free-text amount defensively: drop currency symbols, spaces, and
// thousands separators, then parseFloat. Non-numeric / empty -> 0.
function parseAmount(amount: string): number {
  const cleaned = amount.replace(/[^0-9.]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function totalBalance(loans: Loan[]): number {
  return loans.reduce((sum, l) => sum + parseAmount(l.currentBalance), 0);
}

export function totalMonthly(loans: Loan[]): number {
  return loans.reduce((sum, l) => sum + parseAmount(l.monthlyPayment), 0);
}

export function formatMoney(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

export function sortByNextPaymentDate(loans: Loan[]): Loan[] {
  return [...loans].sort((a, b) => {
    if (!a.nextPaymentDate) return b.nextPaymentDate ? 1 : 0;
    if (!b.nextPaymentDate) return -1;
    return a.nextPaymentDate < b.nextPaymentDate
      ? -1
      : a.nextPaymentDate > b.nextPaymentDate
        ? 1
        : 0;
  });
}

export function maskAccountNumber(value: string): string {
  if (value.length <= 4) return value;
  return "••••" + value.slice(-4);
}
