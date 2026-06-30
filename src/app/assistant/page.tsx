// src/app/assistant/page.tsx
"use client";

import { useState } from "react";
import { type UIMessage } from "ai";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { useAssistant } from "@/app/providers/useAssistant";
import { ProposalCard } from "@/components/assistant/ProposalCard";

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

export default function AssistantPage() {
  const {
    messages,
    status,
    send,
    pendingProposal,
    confirmProposal,
    discardProposal,
    savedNotice,
    error,
    masterKey,
  } = useAssistant();
  const [input, setInput] = useState("");

  if (!masterKey) return null;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    send(input);
    setInput("");
  }

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Assistant</h1>
        <p className="subtle">
          Describe a record in your own words and I&apos;ll help you save it. This chat isn&apos;t stored — only the
          records you choose to save are kept, encrypted on your device.
        </p>

        {messages.map((m) => (
          <MessageText key={m.id} message={m} />
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
            placeholder="e.g. Add my Wells Fargo mortgage, about 280k left at 6.1%"
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
