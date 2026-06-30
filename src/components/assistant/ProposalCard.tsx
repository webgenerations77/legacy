// src/components/assistant/ProposalCard.tsx
"use client";

import { useState } from "react";
import {
  RECORD_SCHEMA_BY_KEY,
  type RecordTypeKey,
  type ProposedFields,
  type FieldSchema,
} from "@/lib/assistant/record-schemas";

export function ProposalCard(props: {
  type: RecordTypeKey;
  initialFields: ProposedFields;
  onSave: (type: RecordTypeKey, fields: ProposedFields) => void;
  onDiscard: () => void;
  error: string | null;
}) {
  const schema = RECORD_SCHEMA_BY_KEY[props.type];
  const [fields, setFields] = useState<ProposedFields>(props.initialFields);

  function setField(key: string, value: string | boolean) {
    setFields((f) => ({ ...f, [key]: value }));
  }

  const missingRequired = schema.fields
    .filter((f) => f.required)
    .some((f) => {
      const v = fields[f.key];
      return v === undefined || (typeof v === "string" && v.trim() === "");
    });

  return (
    <div className="item">
      <p className="subtle">
        Review this {schema.label.toLowerCase()} — it saves to your encrypted vault only when you click Save.
      </p>
      {schema.fields.map((f: FieldSchema) => {
        const id = `proposal-${f.key}`;
        const value = fields[f.key];
        if (f.kind === "boolean") {
          return (
            <label key={f.key} htmlFor={id}>
              <input
                id={id}
                type="checkbox"
                checked={value === true}
                onChange={(e) => setField(f.key, e.target.checked)}
              />{" "}
              {f.label}
            </label>
          );
        }
        const text = typeof value === "string" ? value : "";
        return (
          <div key={f.key}>
            <label htmlFor={id}>
              {f.label}
              {f.required ? " *" : ""}
            </label>
            {f.options ? (
              <select id={id} value={text} onChange={(e) => setField(f.key, e.target.value)}>
                <option value="">—</option>
                {f.options.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            ) : f.kind === "longtext" ? (
              <textarea id={id} value={text} onChange={(e) => setField(f.key, e.target.value)} />
            ) : (
              <input
                id={id}
                type={f.kind === "date" ? "date" : "text"}
                value={text}
                onChange={(e) => setField(f.key, e.target.value)}
              />
            )}
          </div>
        );
      })}
      {props.error && <p className="error">{props.error}</p>}
      <div className="row">
        <button type="button" disabled={missingRequired} onClick={() => props.onSave(props.type, fields)}>
          Save
        </button>
        <button type="button" className="linkbtn" onClick={props.onDiscard}>
          Discard
        </button>
      </div>
    </div>
  );
}
