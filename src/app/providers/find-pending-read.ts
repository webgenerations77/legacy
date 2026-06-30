import { isToolUIPart, getToolName, type UIMessage } from "ai";
import { RECORD_SCHEMA_BY_KEY, type RecordTypeKey } from "@/lib/assistant/record-schemas";

export interface PendingRead {
  toolCallId: string;
  types: RecordTypeKey[];
}

export function findPendingRead(messages: UIMessage[]): PendingRead | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const part of messages[i].parts) {
      if (
        isToolUIPart(part) &&
        getToolName(part) === "readRecords" &&
        part.state === "input-available"
      ) {
        const raw = (part as { input: unknown }).input;
        const input = (raw ?? {}) as { types?: unknown };
        const types = Array.isArray(input.types)
          ? input.types.filter(
              (t): t is RecordTypeKey =>
                typeof t === "string" && t in RECORD_SCHEMA_BY_KEY,
            )
          : [];
        return { toolCallId: part.toolCallId, types };
      }
    }
  }
  return null;
}
