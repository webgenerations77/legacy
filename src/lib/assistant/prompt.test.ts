import { describe, it, expect } from "vitest";
import { buildAssistantSystemPrompt } from "@/lib/assistant/prompt";

describe("buildAssistantSystemPrompt", () => {
  const prompt = buildAssistantSystemPrompt();

  it("names every record type key", () => {
    for (const key of ["account", "bill", "loan", "beneficiary", "vault"]) {
      expect(prompt).toContain(key);
    }
  });

  it("instructs the model to call proposeRecord, one record at a time", () => {
    expect(prompt).toContain("proposeRecord");
    expect(prompt.toLowerCase()).toContain("one record at a time");
  });

  it("states records are encrypted and must be read via readRecords, not guessed", () => {
    expect(prompt).toContain("institution"); // still lists a required field
    expect(prompt).toContain("readRecords");
    const lower = prompt.toLowerCase();
    expect(lower).toContain("encrypted");
    expect(lower).toContain("only the categories");
    expect(lower).toContain("never guess");
  });

  it("describes the proactive readiness-summary interview", () => {
    const lower = prompt.toLowerCase();
    expect(lower).toContain("readiness summary");
    expect(lower).toContain("what to add next");
  });
});
