"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  type UIMessage,
} from "ai";
import { useKey } from "@/app/providers/KeyProvider";
import { encryptItem } from "@/lib/crypto";
import { api } from "@/lib/api-client";
import {
  toPlaintext,
  RECORD_SCHEMA_BY_KEY,
  MissingRequiredFieldError,
  type RecordTypeKey,
  type ProposedFields,
} from "@/lib/assistant/record-schemas";
import {
  findPendingProposal,
  type PendingProposal,
} from "@/app/providers/find-pending-proposal";
import { type EditTarget } from "@/app/providers/useEditTarget";

export type { PendingProposal };

export function useAssistant(editTarget: EditTarget | null = null) {
  const router = useRouter();
  const { masterKey } = useKey();
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chat = useChat({
    transport: new DefaultChatTransport({ api: "/api/assistant/chat" }),
    onError: () => setError("The assistant hit a snag. Please try again."),
  });

  useEffect(() => {
    if (!masterKey) router.replace("/unlock");
  }, [masterKey, router]);

  const pendingProposal = useMemo(() => {
    const raw = findPendingProposal(chat.messages as UIMessage[]);
    if (!raw) return null;
    if (editTarget) {
      return {
        toolCallId: raw.toolCallId,
        type: editTarget.type,
        fields: { ...editTarget.currentFields, ...raw.fields },
      };
    }
    return raw;
  }, [chat.messages, editTarget]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setError(null);
      setSavedNotice(null);
      if (editTarget) {
        chat.sendMessage(
          { text: trimmed },
          { body: { editContext: { type: editTarget.type, currentFields: editTarget.currentFields } } },
        );
      } else {
        chat.sendMessage({ text: trimmed });
      }
    },
    [chat, editTarget],
  );

  const confirmProposal = useCallback(
    async (type: RecordTypeKey, fields: ProposedFields) => {
      if (!masterKey || !pendingProposal) return;
      setError(null);
      try {
        const plaintext = toPlaintext(type, fields);
        const { ciphertext, iv } = await encryptItem(masterKey, plaintext);
        if (editTarget) {
          await api.updateRecord(RECORD_SCHEMA_BY_KEY[editTarget.type].resource, editTarget.id, ciphertext, iv);
        } else {
          await api.addRecord(RECORD_SCHEMA_BY_KEY[type].resource, ciphertext, iv);
        }
        await chat.addToolOutput({
          tool: "proposeRecord",
          toolCallId: pendingProposal.toolCallId,
          output: { saved: true, type },
        });
        setSavedNotice(
          editTarget
            ? `Updated your ${RECORD_SCHEMA_BY_KEY[type].label.toLowerCase()}.`
            : `Saved your ${RECORD_SCHEMA_BY_KEY[type].label.toLowerCase()}.`,
        );
      } catch (e) {
        if (e instanceof MissingRequiredFieldError) {
          setError(`Please fill in the ${e.field} field before saving.`);
        } else {
          setError("We couldn't save that. Please try again.");
        }
      }
    },
    [masterKey, pendingProposal, chat, editTarget],
  );

  const discardProposal = useCallback(async () => {
    if (!pendingProposal) return;
    setSavedNotice(null);
    setError(null);
    await chat.addToolOutput({
      tool: "proposeRecord",
      toolCallId: pendingProposal.toolCallId,
      output: { saved: false },
    });
  }, [pendingProposal, chat]);

  const deletePinned = useCallback(async (): Promise<boolean> => {
    if (!editTarget) return false;
    setError(null);
    try {
      await api.deleteRecord(RECORD_SCHEMA_BY_KEY[editTarget.type].resource, editTarget.id);
      return true;
    } catch {
      setError("We couldn't delete that record.");
      return false;
    }
  }, [editTarget]);

  return {
    messages: chat.messages as UIMessage[],
    status: chat.status,
    send,
    pendingProposal,
    confirmProposal,
    discardProposal,
    deletePinned,
    savedNotice,
    error,
    masterKey,
  };
}
