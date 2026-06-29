import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { findOrCreateGoogleUser } from "@/lib/google-user";

const emails: string[] = [];
function freshEmail(tag: string) {
  const e = `g-${tag}-${Date.now()}@example.com`;
  emails.push(e);
  return e;
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

describe("findOrCreateGoogleUser", () => {
  it("creates a new user for an unseen googleId, with null vault fields", async () => {
    const email = freshEmail("new");
    const googleId = `gid-new-${Date.now()}`;
    const res = await findOrCreateGoogleUser({ googleId, email });
    expect(res.ok).toBe(true);
    const user = await prisma.user.findUnique({ where: { googleId } });
    expect(user?.email).toBe(email);
    expect(user?.kdfSalt).toBeNull();
    expect(user?.authVerifierHash).toBeNull();
  });

  it("returns the same user id for a repeated googleId (idempotent)", async () => {
    const email = freshEmail("repeat");
    const googleId = `gid-repeat-${Date.now()}`;
    const first = await findOrCreateGoogleUser({ googleId, email });
    const second = await findOrCreateGoogleUser({ googleId, email });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.userId).toBe(first.userId);
  });

  it("refuses when the email already belongs to a passphrase account (linking deferred)", async () => {
    const email = freshEmail("taken");
    await prisma.user.create({ data: { email, kdfSalt: "s", authVerifierHash: "h" } });
    const res = await findOrCreateGoogleUser({ googleId: `gid-taken-${Date.now()}`, email });
    expect(res).toEqual({ ok: false, reason: "email_taken" });
  });
});
