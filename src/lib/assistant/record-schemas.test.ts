import { describe, it, expect } from "vitest";
import {
  RECORD_SCHEMAS,
  RECORD_SCHEMA_BY_KEY,
  toPlaintext,
  buildProposeRecordJsonSchema,
  MissingRequiredFieldError,
  parseToFields,
  type RecordTypeKey,
} from "@/lib/assistant/record-schemas";
import { parseAccount } from "@/lib/account";
import { parseBill } from "@/lib/bill";
import { parseLoan } from "@/lib/loan";
import { parseBeneficiary } from "@/lib/beneficiary";

describe("record-schemas", () => {
  it("exposes all five record types with a resource and at least one required field", () => {
    expect(RECORD_SCHEMAS.map((s) => s.key).sort()).toEqual(
      ["account", "beneficiary", "bill", "loan", "vault"].sort(),
    );
    expect(RECORD_SCHEMA_BY_KEY.account.resource).toBe("accounts");
    expect(RECORD_SCHEMA_BY_KEY.bill.resource).toBe("bills");
    expect(RECORD_SCHEMA_BY_KEY.loan.resource).toBe("loans");
    expect(RECORD_SCHEMA_BY_KEY.beneficiary.resource).toBe("beneficiaries");
    expect(RECORD_SCHEMA_BY_KEY.vault.resource).toBe("vault");
    for (const s of RECORD_SCHEMAS) {
      expect(s.fields.some((f) => f.required)).toBe(true);
    }
  });

  it("toPlaintext('account') round-trips through serializeAccount with defaults", () => {
    const json = toPlaintext("account", { institution: "Chase", accountType: "Checking", balance: "100" });
    expect(parseAccount(json)).toEqual({
      type: "Checking",
      institution: "Chase",
      nickname: "",
      accountNumber: "",
      balance: "100",
      notes: "",
    });
  });

  it("toPlaintext('account') falls back to 'Other' for an unknown type value", () => {
    const json = toPlaintext("account", { institution: "Chase", accountType: "Nonsense" });
    expect(parseAccount(json).type).toBe("Other");
  });

  it("toPlaintext('bill') carries a boolean autoPay and defaults frequency to Monthly", () => {
    const bill = parseBill(toPlaintext("bill", { name: "Netflix", autoPay: true }));
    expect(bill.autoPay).toBe(true);
    expect(bill.frequency).toBe("Monthly");
    expect(bill.category).toBe("Other");
  });

  it("toPlaintext('loan') and ('beneficiary') round-trip required fields", () => {
    expect(parseLoan(toPlaintext("loan", { lender: "Wells Fargo" })).lender).toBe("Wells Fargo");
    expect(parseBeneficiary(toPlaintext("beneficiary", { fullName: "Sam Lee" })).fullName).toBe("Sam Lee");
  });

  it("toPlaintext('vault') returns the raw note string (no JSON)", () => {
    expect(toPlaintext("vault", { note: "remember the safe code" })).toBe("remember the safe code");
  });

  it("throws MissingRequiredFieldError when a required field is missing or blank", () => {
    expect(() => toPlaintext("account", {})).toThrowError(MissingRequiredFieldError);
    expect(() => toPlaintext("account", { institution: "   " })).toThrowError(MissingRequiredFieldError);
  });

  it("throws MissingRequiredFieldError for vault and provides field name", () => {
    expect.assertions(2);
    try {
      toPlaintext("vault", {});
    } catch (e) {
      expect(e).toBeInstanceOf(MissingRequiredFieldError);
      expect((e as MissingRequiredFieldError).field).toBe("note");
    }
  });

  it("buildProposeRecordJsonSchema yields one oneOf branch per type with the discriminant + required keys", () => {
    const schema = buildProposeRecordJsonSchema() as {
      oneOf: { properties: { type: { enum: string[] } }; required: string[] }[];
    };
    expect(schema.oneOf).toHaveLength(5);
    const account = schema.oneOf.find((b) => b.properties.type.enum[0] === "account")!;
    expect(account.required).toContain("type");
    expect(account.required).toContain("institution");
    const vault = schema.oneOf.find((b) => b.properties.type.enum[0] === "vault")!;
    expect(vault.required).toContain("note");
  });

  it("captures account type through the downstream destructuring pattern", () => {
    const input = { type: "account", accountType: "Savings", institution: "Chase" };
    const { type, ...fields } = input;
    expect(parseAccount(toPlaintext(type as RecordTypeKey, fields)).type).toBe("Savings");
  });
});

describe("parseToFields", () => {
  it("round-trips with toPlaintext for an account (incl. type → accountType)", () => {
    const fields = { institution: "Chase", accountType: "Savings", balance: "100" };
    const pt = toPlaintext("account", fields);
    const back = parseToFields("account", pt);
    expect(back.institution).toBe("Chase");
    expect(back.accountType).toBe("Savings"); // domain `.type` mapped back to field key
    expect(back.balance).toBe("100");
  });

  it("round-trips a bill's boolean autoPay", () => {
    const pt = toPlaintext("bill", { name: "Netflix", autoPay: true });
    const back = parseToFields("bill", pt);
    expect(back.name).toBe("Netflix");
    expect(back.autoPay).toBe(true);
  });

  it("maps vault plaintext to a note field", () => {
    expect(parseToFields("vault", "the safe code is 1234")).toEqual({ note: "the safe code is 1234" });
  });

  it("round-trips loan and beneficiary required fields", () => {
    expect(parseToFields("loan", toPlaintext("loan", { lender: "Wells Fargo" })).lender).toBe("Wells Fargo");
    expect(parseToFields("beneficiary", toPlaintext("beneficiary", { fullName: "Sam Lee" })).fullName).toBe("Sam Lee");
  });

  it("degrades to {} on malformed non-vault plaintext rather than throwing", () => {
    expect(parseToFields("account", "not json{")).toEqual({});
  });
});
