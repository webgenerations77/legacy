import {
  type CryptoBytes,
  deriveMasterKey,
  deriveAuthVerifier,
  encryptItem,
  decryptItem,
  generateSalt,
  bytesToBase64,
  base64ToBytes,
} from "@/lib/crypto";
import { generateRecoveryCode, normalizeRecoveryCode } from "@/lib/survivor";

export type ArmResult = {
  recoveryCode: string;
  survivorSalt: string;
  survivorAuthVerifier: string;
  escrowCiphertext: string;
  escrowIv: string;
};

/** Derive the survivor key from a recovery code (normalized) + salt. */
async function survivorKeyFrom(recoveryCode: string, survivorSalt: string): Promise<CryptoBytes> {
  return deriveMasterKey(normalizeRecoveryCode(recoveryCode), survivorSalt);
}

/** Owner-side: generate a code + salt and wrap the master key for escrow. */
export async function buildSurvivorEscrow(masterKey: CryptoBytes): Promise<ArmResult> {
  const recoveryCode = generateRecoveryCode();
  const survivorSalt = generateSalt();
  const survivorKey = await survivorKeyFrom(recoveryCode, survivorSalt);
  const { ciphertext, iv } = await encryptItem(survivorKey, bytesToBase64(masterKey));
  const survivorAuthVerifier = await deriveAuthVerifier(
    survivorKey,
    normalizeRecoveryCode(recoveryCode),
  );
  return {
    recoveryCode,
    survivorSalt,
    survivorAuthVerifier,
    escrowCiphertext: ciphertext,
    escrowIv: iv,
  };
}

/** Survivor-side: the verifier the server bcrypt-checks before releasing data. */
export async function deriveSurvivorAuthVerifier(
  recoveryCode: string,
  survivorSalt: string,
): Promise<string> {
  const survivorKey = await survivorKeyFrom(recoveryCode, survivorSalt);
  return deriveAuthVerifier(survivorKey, normalizeRecoveryCode(recoveryCode));
}

/** Survivor-side: unwrap the real master key from the escrow blob. */
export async function recoverMasterKey(
  recoveryCode: string,
  survivorSalt: string,
  escrowCiphertext: string,
  escrowIv: string,
): Promise<CryptoBytes> {
  const survivorKey = await survivorKeyFrom(recoveryCode, survivorSalt);
  const masterKeyB64 = await decryptItem(survivorKey, escrowCiphertext, escrowIv);
  return base64ToBytes(masterKeyB64);
}
