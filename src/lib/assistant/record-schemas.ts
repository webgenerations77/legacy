import { serializeAccount, type Account, type AccountType } from "@/lib/account";
import {
  serializeBill,
  type Bill,
  type BillCategory,
  type Frequency,
} from "@/lib/bill";
import { serializeLoan, type Loan, type LoanKind } from "@/lib/loan";
import {
  serializeBeneficiary,
  type Beneficiary,
  type BeneficiaryRelationship,
} from "@/lib/beneficiary";
import { type JSONSchema7 } from "ai";

export type RecordTypeKey = "account" | "bill" | "loan" | "beneficiary" | "vault";
export type FieldKind = "text" | "longtext" | "number" | "date" | "boolean";

export interface FieldSchema {
  key: string;
  label: string;
  required: boolean;
  kind: FieldKind;
  options?: readonly string[];
}

export interface RecordTypeSchema {
  key: RecordTypeKey;
  label: string;
  resource: string;
  fields: readonly FieldSchema[];
}

export type ProposedFields = Record<string, string | boolean | undefined>;

const ACCOUNT_TYPES: readonly AccountType[] = ["Checking", "Savings", "Investment", "Retirement", "Other"];
const BILL_CATEGORIES: readonly BillCategory[] = ["Utility", "Streaming", "Insurance", "Loan", "Subscription", "Other"];
const FREQUENCIES: readonly Frequency[] = ["Weekly", "Monthly", "Quarterly", "Annual", "One-time"];
const LOAN_KINDS: readonly LoanKind[] = ["Mortgage", "Auto", "Student", "Personal", "HELOC", "Other"];
const RELATIONSHIPS: readonly BeneficiaryRelationship[] = ["Spouse", "Child", "Parent", "Sibling", "Friend", "Trust", "Charity", "Other"];

export const RECORD_SCHEMAS: readonly RecordTypeSchema[] = [
  {
    key: "account",
    label: "Financial account",
    resource: "accounts",
    fields: [
      { key: "institution", label: "Institution", required: true, kind: "text" },
      { key: "accountType", label: "Account type", required: false, kind: "text", options: ACCOUNT_TYPES },
      { key: "nickname", label: "Nickname", required: false, kind: "text" },
      { key: "accountNumber", label: "Account number", required: false, kind: "text" },
      { key: "balance", label: "Balance", required: false, kind: "number" },
      { key: "notes", label: "Notes", required: false, kind: "longtext" },
    ],
  },
  {
    key: "bill",
    label: "Bill or subscription",
    resource: "bills",
    fields: [
      { key: "name", label: "Name", required: true, kind: "text" },
      { key: "category", label: "Category", required: false, kind: "text", options: BILL_CATEGORIES },
      { key: "amount", label: "Amount", required: false, kind: "number" },
      { key: "frequency", label: "Frequency", required: false, kind: "text", options: FREQUENCIES },
      { key: "nextDueDate", label: "Next due date", required: false, kind: "date" },
      { key: "paymentMethod", label: "Payment method", required: false, kind: "text" },
      { key: "autoPay", label: "Auto-pay", required: false, kind: "boolean" },
      { key: "website", label: "Website", required: false, kind: "text" },
      { key: "notes", label: "Notes", required: false, kind: "longtext" },
    ],
  },
  {
    key: "loan",
    label: "Loan or mortgage",
    resource: "loans",
    fields: [
      { key: "lender", label: "Lender", required: true, kind: "text" },
      { key: "kind", label: "Loan type", required: false, kind: "text", options: LOAN_KINDS },
      { key: "nickname", label: "Nickname", required: false, kind: "text" },
      { key: "accountNumber", label: "Account number", required: false, kind: "text" },
      { key: "originalAmount", label: "Original amount", required: false, kind: "number" },
      { key: "currentBalance", label: "Current balance", required: false, kind: "number" },
      { key: "interestRate", label: "Interest rate", required: false, kind: "text" },
      { key: "monthlyPayment", label: "Monthly payment", required: false, kind: "number" },
      { key: "nextPaymentDate", label: "Next payment date", required: false, kind: "date" },
      { key: "payoffDate", label: "Payoff date", required: false, kind: "date" },
      { key: "notes", label: "Notes", required: false, kind: "longtext" },
    ],
  },
  {
    key: "beneficiary",
    label: "Beneficiary",
    resource: "beneficiaries",
    fields: [
      { key: "fullName", label: "Full name", required: true, kind: "text" },
      { key: "relationship", label: "Relationship", required: false, kind: "text", options: RELATIONSHIPS },
      { key: "email", label: "Email", required: false, kind: "text" },
      { key: "phone", label: "Phone", required: false, kind: "text" },
      { key: "mailingAddress", label: "Mailing address", required: false, kind: "longtext" },
      { key: "allocation", label: "Allocation %", required: false, kind: "number" },
      { key: "notes", label: "Notes", required: false, kind: "longtext" },
    ],
  },
  {
    key: "vault",
    label: "Private note",
    resource: "vault",
    fields: [{ key: "note", label: "Note", required: true, kind: "longtext" }],
  },
];

export const RECORD_SCHEMA_BY_KEY: Record<RecordTypeKey, RecordTypeSchema> = Object.fromEntries(
  RECORD_SCHEMAS.map((s) => [s.key, s]),
) as Record<RecordTypeKey, RecordTypeSchema>;

export class MissingRequiredFieldError extends Error {
  constructor(public readonly field: string) {
    super(`Missing required field: ${field}`);
    this.name = "MissingRequiredFieldError";
  }
}

function str(fields: ProposedFields, key: string): string {
  const v = fields[key];
  return typeof v === "string" ? v : "";
}
function bool(fields: ProposedFields, key: string): boolean {
  return fields[key] === true;
}
function pick<T extends string>(fields: ProposedFields, key: string, options: readonly T[], fallback: T): T {
  const v = fields[key];
  return typeof v === "string" && (options as readonly string[]).includes(v) ? (v as T) : fallback;
}

function assertRequired(schema: RecordTypeSchema, fields: ProposedFields): void {
  for (const f of schema.fields) {
    if (!f.required) continue;
    const v = fields[f.key];
    if (v === undefined || (typeof v === "string" && v.trim() === "")) {
      throw new MissingRequiredFieldError(f.key);
    }
  }
}

export function toPlaintext(type: RecordTypeKey, fields: ProposedFields): string {
  const schema = RECORD_SCHEMA_BY_KEY[type];
  if (!schema) throw new Error(`Unknown record type: ${type}`);
  assertRequired(schema, fields);
  switch (type) {
    case "vault":
      return str(fields, "note");
    case "account": {
      const a: Account = {
        type: pick(fields, "accountType", ACCOUNT_TYPES, "Other"),
        institution: str(fields, "institution"),
        nickname: str(fields, "nickname"),
        accountNumber: str(fields, "accountNumber"),
        balance: str(fields, "balance"),
        notes: str(fields, "notes"),
      };
      return serializeAccount(a);
    }
    case "bill": {
      const b: Bill = {
        name: str(fields, "name"),
        category: pick(fields, "category", BILL_CATEGORIES, "Other"),
        amount: str(fields, "amount"),
        frequency: pick(fields, "frequency", FREQUENCIES, "Monthly"),
        nextDueDate: str(fields, "nextDueDate"),
        paymentMethod: str(fields, "paymentMethod"),
        autoPay: bool(fields, "autoPay"),
        website: str(fields, "website"),
        notes: str(fields, "notes"),
      };
      return serializeBill(b);
    }
    case "loan": {
      const l: Loan = {
        kind: pick(fields, "kind", LOAN_KINDS, "Other"),
        lender: str(fields, "lender"),
        nickname: str(fields, "nickname"),
        accountNumber: str(fields, "accountNumber"),
        originalAmount: str(fields, "originalAmount"),
        currentBalance: str(fields, "currentBalance"),
        interestRate: str(fields, "interestRate"),
        monthlyPayment: str(fields, "monthlyPayment"),
        nextPaymentDate: str(fields, "nextPaymentDate"),
        payoffDate: str(fields, "payoffDate"),
        notes: str(fields, "notes"),
      };
      return serializeLoan(l);
    }
    case "beneficiary": {
      const bn: Beneficiary = {
        fullName: str(fields, "fullName"),
        relationship: pick(fields, "relationship", RELATIONSHIPS, "Other"),
        email: str(fields, "email"),
        phone: str(fields, "phone"),
        mailingAddress: str(fields, "mailingAddress"),
        allocation: str(fields, "allocation"),
        notes: str(fields, "notes"),
      };
      return serializeBeneficiary(bn);
    }
  }
}

function fieldToJsonSchema(f: FieldSchema): JSONSchema7 {
  if (f.kind === "boolean") return { type: "boolean", description: f.label };
  if (f.options) return { type: "string", enum: [...f.options], description: f.label };
  return { type: "string", description: f.label };
}

function branch(schema: RecordTypeSchema): JSONSchema7 {
  const properties: Record<string, JSONSchema7> = {
    type: { type: "string", enum: [schema.key], description: `Use for: ${schema.label}` },
  };
  const required: string[] = ["type"];
  for (const f of schema.fields) {
    properties[f.key] = fieldToJsonSchema(f);
    if (f.required) required.push(f.key);
  }
  return { type: "object", additionalProperties: false, properties, required };
}

// Inverse of toPlaintext: stored plaintext → editable ProposedFields (field keys).
// The account domain object's `.type` maps back to the `accountType` field key
// (the discriminant-collision fix from Slice A, in reverse). Vault is a raw string.
export function parseToFields(type: RecordTypeKey, plaintext: string): ProposedFields {
  if (type === "vault") return { note: plaintext };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(plaintext) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (typeof obj !== "object" || obj === null) return {};
  const fields: ProposedFields = {};
  for (const f of RECORD_SCHEMA_BY_KEY[type].fields) {
    // account's "accountType" field reads from the domain object's "type" key.
    const sourceKey = type === "account" && f.key === "accountType" ? "type" : f.key;
    const v = obj[sourceKey];
    if (typeof v === "string" || typeof v === "boolean") fields[f.key] = v;
  }
  return fields;
}

export function buildProposeRecordJsonSchema(): JSONSchema7 {
  return {
    type: "object",
    description:
      "A single proposed Legacy record. Pick the matching `type` and fill the fields you know; leave unknown fields out.",
    oneOf: RECORD_SCHEMAS.map(branch),
  };
}
