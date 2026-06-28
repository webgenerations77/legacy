export const SESSION_COOKIE = "legacy_session";

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  };
}

export function sessionExpiry(): Date {
  const raw = Number(process.env.SESSION_TTL_HOURS);
  const hours = Number.isFinite(raw) && raw > 0 ? raw : 12;
  return new Date(Date.now() + hours * 3600 * 1000);
}
