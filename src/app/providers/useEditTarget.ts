"use client";

import { useEffect, useState } from "react";
import { useKey } from "@/app/providers/KeyProvider";
import { api } from "@/lib/api-client";
import { decryptItem } from "@/lib/crypto";
import {
  parseToFields,
  RECORD_SCHEMA_BY_KEY,
  type RecordTypeKey,
  type ProposedFields,
} from "@/lib/assistant/record-schemas";

export interface EditTarget {
  type: RecordTypeKey;
  id: string;
  label: string;
  currentFields: ProposedFields;
}

interface EncryptedRow {
  id: string;
  ciphertext: string;
  iv: string;
}

function isRecordType(t: string): t is RecordTypeKey {
  return t in RECORD_SCHEMA_BY_KEY;
}

export function useEditTarget(params: { type: string; id: string } | null): {
  editTarget: EditTarget | null;
  loadError: string | null;
} {
  const { masterKey } = useKey();
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const type = params?.type ?? null;
  const id = params?.id ?? null;

  useEffect(() => {
    if (!type || !id || !masterKey || !isRecordType(type)) {
      setEditTarget(null);
      setLoadError(null);
      return;
    }
    const schema = RECORD_SCHEMA_BY_KEY[type];
    let active = true;
    (async () => {
      setLoadError(null);
      setEditTarget(null);
      try {
        const data = await api.listRecords(schema.resource);
        const rows = (data[schema.resource] ?? data.items ?? []) as EncryptedRow[];
        const row = rows.find((r) => r.id === id);
        if (!row) {
          if (active) setLoadError("We couldn't find that record to edit.");
          return;
        }
        const plaintext = await decryptItem(masterKey, row.ciphertext, row.iv);
        const currentFields = parseToFields(type, plaintext);
        if (active) setEditTarget({ type, id, label: schema.label, currentFields });
      } catch {
        if (active) setLoadError("We couldn't load that record to edit.");
      }
    })();
    return () => {
      active = false;
    };
  }, [type, id, masterKey]);

  return { editTarget, loadError };
}
