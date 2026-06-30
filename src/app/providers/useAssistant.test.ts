import { describe, it, expect } from "vitest";
import { findPendingProposal } from "./find-pending-proposal";
import type { UIMessage } from "ai";

// Helpers to build minimal UIMessage-shaped fixtures.
// Cast through `unknown` so TypeScript accepts our deliberately-minimal shapes.
function makeMsg(parts: unknown[]): UIMessage {
  return { id: "m", role: "assistant", parts } as unknown as UIMessage;
}

function toolPart(
  state: string,
  input: Record<string, unknown>,
  toolCallId: string,
) {
  return { type: "tool-proposeRecord", state, input, toolCallId };
}

describe("findPendingProposal", () => {
  it("returns null for an empty messages array", () => {
    expect(findPendingProposal([])).toBeNull();
  });

  it("returns null when the latest proposeRecord part has state output-available (resolved)", () => {
    const messages = [
      makeMsg([
        { ...toolPart("output-available", { type: "vault", note: "x" }, "t1"), output: { saved: true } },
      ]),
    ];
    expect(findPendingProposal(messages)).toBeNull();
  });

  it("returns PendingProposal when a valid input-available vault proposeRecord exists", () => {
    const messages = [
      makeMsg([toolPart("input-available", { type: "vault", note: "x" }, "t1")]),
    ];
    expect(findPendingProposal(messages)).toEqual({
      toolCallId: "t1",
      type: "vault",
      fields: { note: "x" },
    });
  });

  it("returns null (no throw) when input.type is not a known record type", () => {
    const messages = [
      makeMsg([toolPart("input-available", { type: "bogus", field: "value" }, "t1")]),
    ];
    expect(() => findPendingProposal(messages)).not.toThrow();
    expect(findPendingProposal(messages)).toBeNull();
  });

  it("returns the most recent unresolved proposal when two assistant messages are present", () => {
    const messages = [
      // older message: resolved proposal
      makeMsg([
        { ...toolPart("output-available", { type: "vault", note: "old" }, "t-old"), output: { saved: true } },
      ]),
      // newer message: unresolved proposal
      makeMsg([toolPart("input-available", { type: "vault", note: "new" }, "t-new")]),
    ];
    const result = findPendingProposal(messages);
    expect(result?.toolCallId).toBe("t-new");
  });
});
