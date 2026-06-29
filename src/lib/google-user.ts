import { prisma } from "@/lib/db";

export type GoogleUserResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "email_taken" };

export async function findOrCreateGoogleUser(identity: {
  googleId: string;
  email: string;
}): Promise<GoogleUserResult> {
  const email = identity.email.trim().toLowerCase();

  const byGoogle = await prisma.user.findUnique({ where: { googleId: identity.googleId } });
  if (byGoogle) return { ok: true, userId: byGoogle.id };

  const byEmail = await prisma.user.findUnique({ where: { email } });
  if (byEmail) return { ok: false, reason: "email_taken" };

  const created = await prisma.user.create({ data: { googleId: identity.googleId, email } });
  return { ok: true, userId: created.id };
}
