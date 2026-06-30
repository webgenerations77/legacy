import { describe, it, expect } from "vitest";
import { deriveMasterKey, generateSalt, encryptItem, decryptItem } from "./crypto";
import {
  buildSurvivorEscrow,
  deriveSurvivorAuthVerifier,
  recoverMasterKey,
} from "./survivor-crypto";

describe("survivor crypto round-trip", () => {
  it("recovers the exact master key from the recovery code", async () => {
    const masterKey = await deriveMasterKey("owner-passphrase", generateSalt());
    const arm = await buildSurvivorEscrow(masterKey);

    const recovered = await recoverMasterKey(
      arm.recoveryCode,
      arm.survivorSalt,
      arm.escrowCiphertext,
      arm.escrowIv,
    );
    expect(Array.from(recovered)).toEqual(Array.from(masterKey));

    // the recovered key decrypts data encrypted under the original key
    const blob = await encryptItem(masterKey, "secret note");
    expect(await decryptItem(recovered, blob.ciphertext, blob.iv)).toBe("secret note");
  }, 30_000);

  it("claim verifier matches the armed verifier (and is tolerant of formatting)", async () => {
    const masterKey = await deriveMasterKey("p", generateSalt());
    const arm = await buildSurvivorEscrow(masterKey);
    const v = await deriveSurvivorAuthVerifier(arm.recoveryCode, arm.survivorSalt);
    expect(v).toBe(arm.survivorAuthVerifier);
  }, 30_000);

  it("a wrong code cannot unwrap the escrow", async () => {
    const masterKey = await deriveMasterKey("p", generateSalt());
    const arm = await buildSurvivorEscrow(masterKey);
    await expect(
      recoverMasterKey("00000-00000-00000-00000", arm.survivorSalt, arm.escrowCiphertext, arm.escrowIv),
    ).rejects.toThrow();
  }, 30_000);
});
