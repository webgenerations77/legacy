import { bytesToBase64 } from "@/lib/crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 (no I,L,O,U)
const CODE_CHARS = 20;
const GROUP = 5;
const enc = new TextEncoder();

function group(chars: string): string {
  return chars.match(new RegExp(`.{1,${GROUP}}`, "g"))!.join("-");
}

/** ~100-bit human-friendly recovery code, e.g. "K7Q2M-9XTR4-ABCDE-0FGHJ". */
export function generateRecoveryCode(): string {
  const bytes = new Uint8Array(CODE_CHARS);
  crypto.getRandomValues(bytes);
  // 256 % 32 === 0, so (b & 31) is an unbiased index into ALPHABET.
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 31];
  return group(out);
}

export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase();
}

export function formatRecoveryCode(raw: string): string {
  return group(normalizeRecoveryCode(raw));
}

/** Deterministic decoy salt for emails with no armed survivor access. */
export async function decoySalt(secret: string, email: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(email.trim().toLowerCase()));
  return bytesToBase64(new Uint8Array(mac).slice(0, 16));
}
