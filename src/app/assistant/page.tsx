// src/app/assistant/page.tsx
"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { type UIMessage } from "ai";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { useAssistant } from "@/app/providers/useAssistant";
import { useEditTarget } from "@/app/providers/useEditTarget";
import { ProposalCard } from "@/components/assistant/ProposalCard";
import { RECORD_SCHEMA_BY_KEY } from "@/lib/assistant/record-schemas";

function MessageText({ message }: { message: UIMessage }) {
  const text = message.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("");
  if (!text) return null;
  return (
    <div className="item">
      <span className="subtle">{message.role === "user" ? "You" : "Assistant"}</span>
      <div>{text}</div>
    </div>
  );
}

function AssistantInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const type = sp.get("type");
  const id = sp.get("id");
  const params = type && id ? { type, id } : null;

  const { editTarget, loadError } = useEditTarget(params);
  const {
    messages,
    status,
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
  } = useAssistant(editTarget);
  const [input, setInput] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (!masterKey) return null;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    send(input);
    setInput("");
  }

  async function onDeletePinned() {
    if (!editTarget) return;
    setConfirmingDelete(false);
    if (await deletePinned()) router.push(`/${RECORD_SCHEMA_BY_KEY[editTarget.type].resource}`);
  }

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Assistant</h1>

        {editTarget ? (
          <>
            <p className="subtle">
              Editing your {editTarget.label.toLowerCase()}. Tell me what to change — I&apos;ll
              update only this record. It stays encrypted on your device.
            </p>
            {confirmingDelete ? (
              <div className="row">
                <button type="button" onClick={onDeletePinned}>
                  Confirm delete
                </button>
                <button type="button" className="linkbtn" onClick={() => setConfirmingDelete(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" className="linkbtn" onClick={() => setConfirmingDelete(true)}>
                Delete this record
              </button>
            )}
          </>
        ) : (
          <>
            <p className="subtle">
              Describe a record in your own words and I&apos;ll help you save it. This chat isn&apos;t
              stored — only the records you choose to save are kept, encrypted on your device.
            </p>
            <button
              type="button"
              className="linkbtn"
              onClick={startInterview}
              disabled={status === "streaming" || status === "submitted"}
            >
              Help me find what&apos;s missing
            </button>
          </>
        )}

        {loadError && <p className="error">{loadError}</p>}

        {messages.map((m) => (
          <MessageText key={m.id} message={m} />
        ))}

        {readNotices.map((n, i) => (
          <p key={i} className="subtle">
            {n}
          </p>
        ))}

        {pendingProposal && (
          <ProposalCard
            key={pendingProposal.toolCallId}
            type={pendingProposal.type}
            initialFields={pendingProposal.fields}
            onSave={confirmProposal}
            onDiscard={discardProposal}
            error={error}
          />
        )}

        {savedNotice && <p className="subtle">{savedNotice}</p>}
        {error && !pendingProposal && <p className="error">{error}</p>}

        <form className="row" onSubmit={onSubmit}>
          <input
            value={input}
            placeholder={
              editTarget ? "e.g. change the rate to 6%" : "e.g. Add my Wells Fargo mortgage, about 280k left at 6.1%"
            }
            onChange={(e) => setInput(e.target.value)}
            disabled={status === "streaming" || status === "submitted"}
          />
          <button type="submit" disabled={status === "streaming" || status === "submitted"}>
            Send
          </button>
        </form>
      </div>
    </main>
  );
}

export default function AssistantPage() {
  return (
    <Suspense fallback={null}>
      <AssistantInner />
    </Suspense>
  );
}
