import {
  isToolUIPart,
  getToolName,
  type UIMessage,
} from "ai";
import {
  RECORD_SCHEMA_BY_KEY,
  type RecordTypeKey,
  type ProposedFields,
} from "@/lib/assistant/record-schemas";

export interface PendingProposal {
  toolCallId: string;
  type: RecordTypeKey;
  fields: ProposedFields;
}

export function findPendingProposal(messages: UIMessage[]): PendingProposal | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const part of messages[i].parts) {
      if (
        isToolUIPart(part) &&
        getToolName(part) === "proposeRecord" &&
        part.state === "input-available"
      ) {
        // `part.input` is typed as `unknown` after the state narrowing; cast to
        // the shape we expect the AI to produce.
        const raw = (part as { input: unknown }).input;
        const input = (raw ?? {}) as { type?: RecordTypeKey } & ProposedFields;
        if (input.type && RECORD_SCHEMA_BY_KEY[input.type]) {
          const { type, ...fields } = input;
          return { toolCallId: part.toolCallId, type, fields };
        }
      }
    }
  }
  return null;
}
