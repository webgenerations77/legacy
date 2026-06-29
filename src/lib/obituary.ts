export type ObituaryTone =
  | "Traditional"
  | "Warm"
  | "Celebratory"
  | "Faith-based";

export type ObituaryLength = "Short" | "Standard" | "Long";

export interface ObituaryIntake {
  subjectName: string;
  dateOfBirth: string;
  dateOfDeath: string;
  placeOrHometown: string;
  lifeStory: string;
  family: string;
  achievements: string;
  hobbies: string;
  tone: ObituaryTone;
  length: ObituaryLength;
  additionalWishes: string;
}

export function serializeIntake(intake: ObituaryIntake): string {
  return JSON.stringify(intake);
}

export function parseIntake(json: string): ObituaryIntake {
  return JSON.parse(json) as ObituaryIntake;
}

const TONE_VOICE: Record<ObituaryTone, string> = {
  Traditional: "Write in a respectful, formal, traditional obituary style.",
  Warm: "Write in a warm, personal, heartfelt tone.",
  Celebratory:
    "Write in an uplifting, celebratory tone that honors a life well-lived.",
  "Faith-based":
    "Write in a faith-centered tone with reverent, spiritual language.",
};

const LENGTH_WORDS: Record<ObituaryLength, number> = {
  Short: 150,
  Standard: 300,
  Long: 500,
};

export function buildObituaryPrompt(intake: ObituaryIntake): {
  system: string;
  prompt: string;
} {
  const words = LENGTH_WORDS[intake.length];
  const system = [
    "You are a compassionate obituary writer.",
    "Write a finished obituary in flowing prose, ready to publish.",
    "Output only the obituary text — no preamble, headings, commentary, or placeholders.",
    TONE_VOICE[intake.tone],
    `Aim for approximately ${words} words.`,
  ].join(" ");

  const fields: [string, string][] = [
    ["Name", intake.subjectName],
    ["Date of birth", intake.dateOfBirth],
    ["Date of death", intake.dateOfDeath],
    ["Place / hometown", intake.placeOrHometown],
    ["Life story", intake.lifeStory],
    ["Family", intake.family],
    ["Achievements", intake.achievements],
    ["Hobbies and interests", intake.hobbies],
    ["Additional wishes", intake.additionalWishes],
  ];
  const details = fields
    .filter(([, value]) => value.trim() !== "")
    .map(([label, value]) => `${label}: ${value.trim()}`)
    .join("\n");

  const prompt = `Write an obituary using these details:\n\n${details}`;
  return { system, prompt };
}
