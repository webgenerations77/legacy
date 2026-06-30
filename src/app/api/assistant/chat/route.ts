import { NextResponse } from "next/server";
import {
  streamText,
  tool,
  jsonSchema,
  convertToModelMessages,
  type UIMessage,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { requireUserId } from "@/lib/route-auth";
import { readJsonBody } from "@/lib/http";
import { buildAssistantSystemPrompt } from "@/lib/assistant/prompt";
import { buildProposeRecordJsonSchema } from "@/lib/assistant/record-schemas";

export const MODEL_ID = "claude-opus-4-8";

// No `execute`: the model only PROPOSES a record. The client renders an
// editable card and performs the (client-encrypted) save itself.
const proposeRecord = tool({
  description:
    "Propose a single Legacy record for the user to review and save. Call this only once you have enough detail for one record.",
  inputSchema: jsonSchema(buildProposeRecordJsonSchema()),
});

export async function POST(req: Request) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  const messages = (body.messages ?? []) as UIMessage[];

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "The assistant is not configured." }, { status: 500 });
  }

  const result = streamText({
    model: anthropic(MODEL_ID),
    system: buildAssistantSystemPrompt(),
    messages: await convertToModelMessages(messages),
    tools: { proposeRecord },
    // Errors after the streamed 200 begins can't change the status code; log
    // them. The client surfaces a failure when the stream errors/arrives empty.
    onError: ({ error }) => {
      console.error("[assistant/chat] streamText error:", error);
    },
  });
  return result.toUIMessageStreamResponse();
}
