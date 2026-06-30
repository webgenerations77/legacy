import { describe, it, expect } from "vitest";
import { findPendingRead } from "./find-pending-read";
import type { UIMessage } from "ai";

function makeMsg(parts: unknown[]): UIMessage {
  return { id: "m", role: "assistant", parts } as unknown as UIMessage;
}
function readPart(state: string, input: Record<string, unknown>, toolCallId: string) {
  return { type: "tool-readRecords", state, input, toolCallId };
}

describe("findPendingRead", () => {
  it("returns null for an empty array", () => {
    expect(findPendingRead([])).toBeNull();
  });

  it("surfaces an input-available readRecords call with known types", () => {
    const messages = [makeMsg([readPart("input-available", { types: ["loan", "bill"] }, "r1")])];
    expect(findPendingRead(messages)).toEqual({ toolCallId: "r1", types: ["loan", "bill"] });
  });

  it("drops unknown type keys but still returns the call", () => {
    const messages = [makeMsg([readPart("input-available", { types: ["loan", "bogus"] }, "r1")])];
    expect(findPendingRead(messages)).toEqual({ toolCallId: "r1", types: ["loan"] });
  });

  it("ignores a readRecords call that already has output", () => {
    const messages = [
      makeMsg([{ ...readPart("output-available", { types: ["loan"] }, "r1"), output: { records: [] } }]),
    ];
    expect(findPendingRead(messages)).toBeNull();
  });

  it("ignores proposeRecord parts", () => {
    const messages = [
      makeMsg([{ type: "tool-proposeRecord", state: "input-available", input: { type: "vault" }, toolCallId: "p1" }]),
    ];
    expect(findPendingRead(messages)).toBeNull();
  });
});
