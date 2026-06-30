import { type ReadinessReport } from "@/lib/readiness";
import {
  RECORD_SCHEMA_BY_KEY,
  type RecordTypeKey,
  type ProposedFields,
} from "@/lib/assistant/record-schemas";

export interface DigestCategory {
  key: string;
  label: string;
  status: "complete" | "attention" | "empty";
  suggestion?: string;
}

export interface ReadinessDigest {
  overall: number;
  categories: DigestCategory[];
}

// Project the readiness report to a compact, CONTENTS-FREE summary for the model.
export function buildReadinessDigest(report: ReadinessReport): ReadinessDigest {
  return {
    overall: report.overall,
    categories: report.categories.map((c) => {
      const out: DigestCategory = { key: c.key, label: c.label, status: c.status };
      if (c.suggestion) out.suggestion = c.suggestion;
      return out;
    }),
  };
}

export interface ModelRecords {
  type: RecordTypeKey;
  label: string;
  count: number;
  records: ProposedFields[];
}

// Package already-decrypted records of one type into a model-readable shape.
export function serializeRecordsForModel(
  type: RecordTypeKey,
  records: ProposedFields[],
): ModelRecords {
  return {
    type,
    label: RECORD_SCHEMA_BY_KEY[type].label,
    count: records.length,
    records,
  };
}
