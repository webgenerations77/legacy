"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  type UIMessage,
} from "ai";
import { useKey } from "@/app/providers/KeyProvider";
import { encryptItem, decryptItem } from "@/lib/crypto";
import { api } from "@/lib/api-client";
import {
  toPlaintext,
  parseToFields,
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
import { findPendingRead } from "@/app/providers/find-pending-read";
import {
  serializeRecordsForModel,
  type ReadinessDigest,
} from "@/lib/assistant/records-digest";
import { loadReadinessDigest } from "@/app/providers/load-readiness-digest";

export type { PendingProposal };

const INTERVIEW_SEED =
  "Help me figure out what's missing from my Legacy and what I should add next.";

interface EncryptedRow {
  id: string;
  ciphertext: string;
  iv: string;
}

// Decrypt every row of one category into editable fields, skipping bad rows.
async function loadCategoryFields(
  masterKey: import("@/lib/crypto").CryptoBytes,
  type: RecordTypeKey,
): Promise<ProposedFields[]> {
  const schema = RECORD_SCHEMA_BY_KEY[type];
  const data = await api.listRecords(schema.resource);
  const rows = (data[schema.resource] ?? data.items ?? []) as EncryptedRow[];
  const out: ProposedFields[] = [];
  for (const r of rows) {
    try {
      out.push(parseToFields(type, await decryptItem(masterKey, r.ciphertext, r.iv)));
    } catch {
      // undecryptable row — skip it
    }
  }
  return out;
}

export function useAssistant(editTarget: EditTarget | null = null) {
  const router = useRouter();
  const { masterKey } = useKey();
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readNotices, setReadNotices] = useState<string[]>([]);
  const handledReads = useRef<Set<string>>(new Set());
  const digestRef = useRef<ReadinessDigest | null>(null);

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

  const ensureDigest = useCallback(async (): Promise<ReadinessDigest | undefined> => {
    if (!masterKey) return undefined;
    if (digestRef.current) return digestRef.current;
    try {
      digestRef.current = await loadReadinessDigest(masterKey);
      return digestRef.current;
    } catch {
      return undefined; // never block chat on a digest failure
    }
  }, [masterKey]);

  const pendingRead = useMemo(
    () => findPendingRead(chat.messages as UIMessage[]),
    [chat.messages],
  );

  useEffect(() => {
    if (!pendingRead || !masterKey) return;
    if (handledReads.current.has(pendingRead.toolCallId)) return;
    handledReads.current.add(pendingRead.toolCallId);
    (async () => {
      try {
        const results = [];
        for (const type of pendingRead.types) {
          const fields = await loadCategoryFields(masterKey, type);
          results.push(serializeRecordsForModel(type, fields));
          setReadNotices((prev) => [
            ...prev,
            `🔓 Read your ${RECORD_SCHEMA_BY_KEY[type].label.toLowerCase()} to answer this.`,
          ]);
        }
        await chat.addToolOutput({
          tool: "readRecords",
          toolCallId: pendingRead.toolCallId,
          output: { records: results },
        });
      } catch {
        await chat.addToolOutput({
          tool: "readRecords",
          toolCallId: pendingRead.toolCallId,
          output: { error: "Could not read those records." },
        });
      }
    })();
  }, [pendingRead, masterKey, chat]);

  const send = useCallback(
    async (text: string) => {
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
        const readinessDigest = await ensureDigest();
        chat.sendMessage({ text: trimmed }, { body: { readinessDigest } });
      }
    },
    [chat, editTarget, ensureDigest],
  );

  const startInterview = useCallback(() => {
    void send(INTERVIEW_SEED);
  }, [send]);

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
        digestRef.current = null;
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
    startInterview,
    readNotices,
    pendingProposal,
    confirmProposal,
    discardProposal,
    deletePinned,
    savedNotice,
    error,
    masterKey,
  };
}
