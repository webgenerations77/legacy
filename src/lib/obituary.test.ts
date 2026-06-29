import { describe, it, expect } from "vitest";
import {
  serializeIntake,
  parseIntake,
  buildObituaryPrompt,
  type ObituaryIntake,
} from "@/lib/obituary";

const sample: ObituaryIntake = {
  subjectName: "Jane Doe",
  dateOfBirth: "1940-01-02",
  dateOfDeath: "2026-05-01",
  placeOrHometown: "Springfield",
  lifeStory: "A devoted teacher for forty years.",
  family: "Survived by two children.",
  achievements: "Founded the town library.",
  hobbies: "",
  tone: "Traditional",
  length: "Short",
  additionalWishes: "",
};

function intake(partial: Partial<ObituaryIntake>): ObituaryIntake {
  return { ...sample, ...partial };
}

describe("obituary domain", () => {
  it("round-trips through serialize/parse, preserving every field", () => {
    expect(parseIntake(serializeIntake(sample))).toEqual(sample);
  });

  it("builds a system prompt reflecting the tone and length presets", () => {
    const { system } = buildObituaryPrompt(sample);
    expect(system.toLowerCase()).toContain("traditional");
    expect(system).toContain("approximately 150 words");

    const faithLong = buildObituaryPrompt(
      intake({ tone: "Faith-based", length: "Long" }),
    );
    expect(faithLong.system.toLowerCase()).toContain("faith");
    expect(faithLong.system).toContain("approximately 500 words");
  });

  it("includes non-empty fields in the prompt and omits empty ones", () => {
    const { prompt } = buildObituaryPrompt(sample);
    expect(prompt).toContain("Name: Jane Doe");
    expect(prompt).toContain("Life story: A devoted teacher for forty years.");
    expect(prompt).not.toContain("Hobbies and interests:"); // hobbies is ""
    expect(prompt).not.toContain("Additional wishes:"); // additionalWishes is ""
  });
});
