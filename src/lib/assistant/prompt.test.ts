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

  it("lists at least one required field and states it never sees saved records", () => {
    expect(prompt).toContain("institution");
    expect(prompt.toLowerCase()).toContain("never see");
  });
});
