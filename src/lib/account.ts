export type AccountType =
  | "Checking"
  | "Savings"
  | "Investment"
  | "Retirement"
  | "Other";

export interface Account {
  type: AccountType;
  institution: string;
  nickname: string;
  accountNumber: string;
  balance: string;
  notes: string;
}

export function serializeAccount(account: Account): string {
  return JSON.stringify(account);
}

export function parseAccount(json: string): Account {
  return JSON.parse(json) as Account;
}

export function maskAccountNumber(value: string): string {
  if (value.length <= 4) return value;
  return "••••" + value.slice(-4);
}
