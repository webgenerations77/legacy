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

export type { PendingProposal };

export function useAssistant() {
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

  const pendingProposal = useMemo(
    () => findPendingProposal(chat.messages as UIMessage[]),
    [chat.messages],
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setError(null);
      setSavedNotice(null);
      chat.sendMessage({ text: trimmed });
    },
    [chat],
  );

  const confirmProposal = useCallback(
    async (type: RecordTypeKey, fields: ProposedFields) => {
      if (!masterKey || !pendingProposal) return;
      setError(null);
      try {
        const plaintext = toPlaintext(type, fields);
        const { ciphertext, iv } = await encryptItem(masterKey, plaintext);
        await api.addRecord(RECORD_SCHEMA_BY_KEY[type].resource, ciphertext, iv);
        await chat.addToolOutput({
          tool: "proposeRecord",
          toolCallId: pendingProposal.toolCallId,
          output: { saved: true, type },
        });
        setSavedNotice(`Saved your ${RECORD_SCHEMA_BY_KEY[type].label.toLowerCase()}.`);
      } catch (e) {
        if (e instanceof MissingRequiredFieldError) {
          setError(`Please fill in the ${e.field} field before saving.`);
        } else {
          setError("We couldn't save that. Please try again.");
        }
      }
    },
    [masterKey, pendingProposal, chat],
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

  return {
    messages: chat.messages as UIMessage[],
    status: chat.status,
    send,
    pendingProposal,
    confirmProposal,
    discardProposal,
    savedNotice,
    error,
    masterKey,
  };
}
