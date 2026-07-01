import { createHmac, timingSafeEqual } from "crypto";

export const PENDING_LINK_COOKIE = "legacy_pending_link";
export const PENDING_LINK_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface PendingLink {
  googleId: string;
  email: string;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Serialize + HMAC-sign a pending-link identity into an opaque cookie value.
 * Format: `base64url(JSON{ googleId, email, exp }).signature`.
 */
export function signPendingLink(
  link: PendingLink,
  secret: string,
  nowMs: number = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({ googleId: link.googleId, email: link.email, exp: nowMs + PENDING_LINK_TTL_MS }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Verify a pending-link cookie value. Returns the identity when the signature
 * is valid and unexpired, else null (tampered, malformed, expired, or absent).
 */
export function verifyPendingLink(
  value: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): PendingLink | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);

  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (typeof decoded !== "object" || decoded === null) return null;
    const { googleId, email, exp } = decoded as Record<string, unknown>;
    if (typeof googleId !== "string" || typeof email !== "string" || typeof exp !== "number") {
      return null;
    }
    if (exp < nowMs) return null;
    return { googleId, email };
  } catch {
    return null;
  }
}

export function pendingLinkCookieOptions() {
  return {
    httpOnly: true as const,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/" as const,
    maxAge: Math.floor(PENDING_LINK_TTL_MS / 1000),
  };
}

export function linkStateSecret(): string {
  return process.env.LINK_STATE_SECRET ?? "";
}
