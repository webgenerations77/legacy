import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import {
  hashVerifier,
  verifyVerifier,
  createSession,
  getSessionUserId,
  deleteSession,
} from "@/lib/auth";

let userId: string;

beforeAll(async () => {
  const u = await prisma.user.create({
    data: { email: `t${Date.now()}@example.com`, kdfSalt: "s", authVerifierHash: "h" },
  });
  userId = u.id;
});

afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("auth", () => {
  it("hashes and verifies an auth verifier", async () => {
    const hash = await hashVerifier("verifier-abc");
    expect(hash).not.toBe("verifier-abc");
    expect(await verifyVerifier("verifier-abc", hash)).toBe(true);
    expect(await verifyVerifier("wrong", hash)).toBe(false);
  });

  it("creates a session that resolves to the user id", async () => {
    const sid = await createSession(userId);
    expect(await getSessionUserId(sid)).toBe(userId);
  });

  it("returns null for unknown or undefined sessions", async () => {
    expect(await getSessionUserId(undefined)).toBeNull();
    expect(await getSessionUserId("does-not-exist")).toBeNull();
  });

  it("deletes a session", async () => {
    const sid = await createSession(userId);
    await deleteSession(sid);
    expect(await getSessionUserId(sid)).toBeNull();
  });
});
