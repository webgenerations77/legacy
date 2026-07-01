import { type CryptoBytes, unwrapDataKey } from "@/lib/crypto";
import { api } from "@/lib/api-client";

/**
 * Resolve the permanent data key (DK) from a passphrase-derived KEK.
 * Wrapped accounts: fetch the wrapped key and unwrap it. Legacy accounts (no
 * wrapped key yet): the derived KEK IS the data key. Requires an active session
 * (the wrapped-key fetch is authenticated) — call only after login/unlock succeeds.
 */
export async function resolveDataKey(kek: CryptoBytes): Promise<CryptoBytes> {
  const wk = await api.wrappedKey();
  if (wk.wrappedKeyCiphertext && wk.wrappedKeyIv) {
    return unwrapDataKey(kek, wk.wrappedKeyCiphertext, wk.wrappedKeyIv);
  }
  return kek;
}
