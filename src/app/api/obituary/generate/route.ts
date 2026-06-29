import { NextResponse } from "next/server";
import { streamText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { requireUserId } from "@/lib/route-auth";
import { readJsonBody } from "@/lib/http";
import { buildObituaryPrompt, type ObituaryIntake } from "@/lib/obituary";

export const MODEL_ID = "claude-opus-4-8";

export async function POST(req: Request) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const intake = body as unknown as ObituaryIntake;
  if (typeof intake.subjectName !== "string" || !intake.subjectName.trim()) {
    return NextResponse.json({ error: "A name is required." }, { status: 400 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "The obituary generator is not configured." },
      { status: 500 },
    );
  }

  const { system, prompt } = buildObituaryPrompt(intake);
  const result = streamText({ model: anthropic(MODEL_ID), system, prompt });
  return result.toTextStreamResponse();
}
