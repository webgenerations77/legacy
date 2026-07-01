import { describe, it, expect } from "vitest";
import {
  generateRecoveryCode,
  normalizeRecoveryCode,
  formatRecoveryCode,
  decoySalt,
} from "./survivor";

describe("recovery code", () => {
  it("generates 4 groups of 5 Crockford-base32 chars", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
  });

  it("generates distinct codes", () => {
    expect(generateRecoveryCode()).not.toBe(generateRecoveryCode());
  });

  it("normalize strips dashes/whitespace and uppercases", () => {
    expect(normalizeRecoveryCode(" k7q2m-9xtr4 ")).toBe("K7Q2M9XTR4");
  });

  it("format regroups a normalized code", () => {
    expect(formatRecoveryCode("k7q2m9xtr4abcde0fghj")).toBe("K7Q2M-9XTR4-ABCDE-0FGHJ");
  });

  it("round-trips generate -> normalize -> format", () => {
    const code = generateRecoveryCode();
    expect(formatRecoveryCode(normalizeRecoveryCode(code))).toBe(code);
  });
});

describe("decoySalt", () => {
  it("is deterministic per (secret, email)", async () => {
    const a = await decoySalt("server-secret", "person@example.com");
    const b = await decoySalt("server-secret", "person@example.com");
    expect(a).toBe(b);
  });

  it("normalizes email casing/whitespace", async () => {
    expect(await decoySalt("s", " Person@Example.com ")).toBe(
      await decoySalt("s", "person@example.com"),
    );
  });

  it("differs by email and looks like a 16-byte base64 salt", async () => {
    const a = await decoySalt("s", "a@example.com");
    const b = await decoySalt("s", "b@example.com");
    expect(a).not.toBe(b);
    // 16 bytes -> 24 base64 chars incl. padding
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});
