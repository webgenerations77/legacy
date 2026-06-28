import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { sessionExpiry } from "@/lib/session-cookie";

const BCRYPT_ROUNDS = 12;

export async function hashVerifier(authVerifier: string): Promise<string> {
  return bcrypt.hash(authVerifier, BCRYPT_ROUNDS);
}

export async function verifyVerifier(
  authVerifier: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(authVerifier, hash);
}

export async function createSession(userId: string): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  const expiresAt = sessionExpiry();
  await prisma.session.create({ data: { id, userId, expiresAt } });
  return id;
}

export async function getSessionUserId(
  sessionId: string | undefined,
): Promise<string | null> {
  if (!sessionId) return null;
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
    return null;
  }
  return session.userId;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
}
