import { describe, it, expect, vi, beforeEach } from "vitest";

const wrappedKey = vi.fn();
vi.mock("@/lib/api-client", () => ({ api: { wrappedKey: () => wrappedKey() } }));

import { resolveDataKey } from "./data-key";
import { deriveMasterKey, generateSalt, wrapDataKey } from "./crypto";

beforeEach(() => wrappedKey.mockReset());

describe("resolveDataKey", () => {
  it("returns the passed KEK when there is no wrapped key (legacy account)", async () => {
    wrappedKey.mockResolvedValue({ wrappedKeyCiphertext: null });
    const kek = await deriveMasterKey("p", generateSalt());
    const dk = await resolveDataKey(kek);
    expect(Array.from(dk)).toEqual(Array.from(kek));
  });

  it("unwraps the data key when a wrapped key is present", async () => {
    const kek = await deriveMasterKey("p", generateSalt());
    const realDk = await deriveMasterKey("dk", generateSalt());
    const { ciphertext, iv } = await wrapDataKey(kek, realDk);
    wrappedKey.mockResolvedValue({ wrappedKeyCiphertext: ciphertext, wrappedKeyIv: iv });
    const dk = await resolveDataKey(kek);
    expect(Array.from(dk)).toEqual(Array.from(realDk));
  });
});
