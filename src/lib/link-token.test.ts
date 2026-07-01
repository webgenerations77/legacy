import { describe, it, expect } from "vitest";
import {
  signPendingLink,
  verifyPendingLink,
  PENDING_LINK_TTL_MS,
} from "./link-token";

const secret = "unit-secret";
const link = { googleId: "google-123", email: "a@example.com" };

describe("link-token", () => {
  it("round-trips a signed pending-link value", () => {
    const value = signPendingLink(link, secret, 1000);
    expect(verifyPendingLink(value, secret, 1000)).toEqual(link);
  });

  it("rejects a value signed with a different secret", () => {
    const value = signPendingLink(link, secret, 1000);
    expect(verifyPendingLink(value, "other-secret", 1000)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const value = signPendingLink(link, secret, 1000);
    const tampered = "x" + value.slice(1);
    expect(verifyPendingLink(tampered, secret, 1000)).toBeNull();
  });

  it("rejects an expired value", () => {
    const value = signPendingLink(link, secret, 1000);
    expect(verifyPendingLink(value, secret, 1000 + PENDING_LINK_TTL_MS + 1)).toBeNull();
  });

  it("rejects undefined / malformed values", () => {
    expect(verifyPendingLink(undefined, secret, 1000)).toBeNull();
    expect(verifyPendingLink("not-a-token", secret, 1000)).toBeNull();
    expect(verifyPendingLink("nodot", secret, 1000)).toBeNull();
  });
});
