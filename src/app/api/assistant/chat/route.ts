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
import {
  buildProposeRecordJsonSchema,
  buildReadRecordsJsonSchema,
} from "@/lib/assistant/record-schemas";

export const MODEL_ID = "claude-opus-4-8";

/** Chat bodies carry the full transcript + tool outputs; allow well beyond the default small-JSON ceiling. */
export const MAX_CHAT_BODY = 1024 * 1024; // 1 MB

// No `execute`: the model only PROPOSES a record. The client renders an
// editable card and performs the (client-encrypted) save itself.
const proposeRecord = tool({
  description:
    "Propose a single Legacy record for the user to review and save. Call this only once you have enough detail for one record.",
  inputSchema: jsonSchema(buildProposeRecordJsonSchema()),
});

// No `execute`: the browser decrypts only the requested categories and returns
// them via addToolOutput. The server never sees record plaintext or persists it.
const readRecords = tool({
  description:
    "Read the user's saved records of the given categories so you can answer their question. The browser decrypts ONLY the requested categories and returns them. Request only the categories you need.",
  inputSchema: jsonSchema(buildReadRecordsJsonSchema()),
});

export async function POST(req: Request) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await readJsonBody(req, MAX_CHAT_BODY);
  if (body instanceof NextResponse) return body;
  const messages = (body.messages ?? []) as UIMessage[];

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "The assistant is not configured." }, { status: 500 });
  }

  const editContext = body.editContext as
    | { type?: string; currentFields?: Record<string, unknown> }
    | undefined;

  let system = buildAssistantSystemPrompt();
  if (editContext?.type && editContext.currentFields) {
    system +=
      `\n\nThe user is editing an existing ${editContext.type} record. ` +
      `Its current values are:\n${JSON.stringify(editContext.currentFields)}\n` +
      `When they describe a change, call proposeRecord with the SAME record type, ` +
      `applying their change and preserving every field they did not mention.`;
  }

  const readinessDigest = body.readinessDigest;
  if (readinessDigest) {
    system +=
      `\n\nReadiness summary of what the user has and is missing ` +
      `(no record contents): ${JSON.stringify(readinessDigest)}\n` +
      `Use it to proactively suggest what to add next when it would help.`;
  }

  const result = streamText({
    model: anthropic(MODEL_ID),
    system,
    messages: await convertToModelMessages(messages),
    tools: { proposeRecord, readRecords },
    // Errors after the streamed 200 begins can't change the status code; log
    // them. The client surfaces a failure when the stream errors/arrives empty.
    onError: ({ error }) => {
      console.error("[assistant/chat] streamText error:", error);
    },
  });
  return result.toUIMessageStreamResponse();
}
