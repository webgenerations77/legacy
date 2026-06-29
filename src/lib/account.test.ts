import { describe, it, expect } from "vitest";
import {
  serializeAccount,
  parseAccount,
  maskAccountNumber,
  type Account,
} from "@/lib/account";

const sample: Account = {
  type: "Savings",
  institution: "First National Bank",
  nickname: "Rainy day",
  accountNumber: "123456784821",
  balance: "12,500",
  notes: "Auto-pays the mortgage",
};

describe("account domain", () => {
  it("round-trips through serialize/parse", () => {
    expect(parseAccount(serializeAccount(sample))).toEqual(sample);
  });

  it("masks an account number to the last four digits", () => {
    expect(maskAccountNumber("123456784821")).toBe("••••4821");
  });

  it("returns short numbers unmasked and empty as empty", () => {
    expect(maskAccountNumber("4821")).toBe("4821");
    expect(maskAccountNumber("12")).toBe("12");
    expect(maskAccountNumber("")).toBe("");
  });
});
