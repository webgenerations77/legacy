export type BeneficiaryRelationship =
  | "Spouse"
  | "Child"
  | "Parent"
  | "Sibling"
  | "Friend"
  | "Trust"
  | "Charity"
  | "Other";

export interface Beneficiary {
  fullName: string;
  relationship: BeneficiaryRelationship;
  email: string;
  phone: string;
  mailingAddress: string;
  allocation: string; // percent as free text, e.g. "50" — "" when unset
  notes: string;
}

export function serializeBeneficiary(b: Beneficiary): string {
  return JSON.stringify(b);
}

export function parseBeneficiary(json: string): Beneficiary {
  return JSON.parse(json) as Beneficiary;
}

// Parse a free-text percentage defensively: drop "%", spaces, and stray
// characters, then parseFloat. Non-numeric / empty -> 0.
function parsePercent(value: string): number {
  const cleaned = value.replace(/[^0-9.]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function totalAllocation(beneficiaries: Beneficiary[]): number {
  return beneficiaries.reduce((sum, b) => sum + parsePercent(b.allocation), 0);
}

export function allocationStatus(total: number): "balanced" | "under" | "over" {
  if (Math.abs(total - 100) < 0.005) return "balanced";
  return total < 100 ? "under" : "over";
}

export function sortByAllocationDesc(beneficiaries: Beneficiary[]): Beneficiary[] {
  return [...beneficiaries].sort((a, b) => {
    const diff = parsePercent(b.allocation) - parsePercent(a.allocation);
    if (diff !== 0) return diff;
    return a.fullName.localeCompare(b.fullName);
  });
}

// Mask a contact string for card display. Emails keep their first letter and
// full domain (j***@example.com); other values (phones) keep the last four
// characters. Values of length <= 4 and "" are returned unchanged.
export function maskContact(value: string): string {
  if (!value) return "";
  const at = value.indexOf("@");
  if (at > 0) {
    return value[0] + "***" + value.slice(at);
  }
  if (value.length <= 4) return value;
  return "••••" + value.slice(-4);
}
