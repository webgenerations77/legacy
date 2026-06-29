"use client";

import Link from "next/link";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { useReadinessData } from "@/app/providers/useReadinessData";
import type { ReadinessCategory } from "@/lib/readiness";

const SECTION_HREF: Record<ReadinessCategory["key"], string> = {
  accounts: "/accounts",
  beneficiaries: "/beneficiaries",
  loans: "/loans",
  bills: "/bills",
  obituary: "/obituary",
  vault: "/vault",
};

const STATUS_LABEL: Record<ReadinessCategory["status"], string> = {
  complete: "Complete",
  attention: "Needs attention",
  empty: "Not started",
};

export default function ReadinessPage() {
  const { report, loading, error, masterKey, toggleAcknowledged } = useReadinessData();
  if (!masterKey) return null;

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Legacy Readiness</h1>
        <p className="subtle">A quick measure of how complete your Legacy is.</p>

        {loading && <p className="subtle">Calculating…</p>}
        {error && <p className="error">{error}</p>}

        {!loading && !error && (
          <>
            <div className="score">
              <strong>{report.overall}%</strong>
              <span className="subtle">
                {report.completeCount} of {report.categories.length} sections complete
              </span>
            </div>

            {report.categories.map((c) => {
              const showToggle = c.acknowledged || c.status === "empty";
              const label = c.acknowledged
                ? "Complete — nothing to add"
                : STATUS_LABEL[c.status];
              return (
                <div className="item" key={c.key}>
                  <div className="readiness-row">
                    <strong>{c.label}</strong>
                    <span className={`pill pill-${c.acknowledged ? "complete" : c.status}`}>{label}</span>
                  </div>
                  {c.suggestion && (
                    <div className="meta">
                      {c.suggestion}{" "}
                      <Link href={SECTION_HREF[c.key]}>Open {c.label}</Link>
                    </div>
                  )}
                  {showToggle && (
                    <label className="checkrow">
                      <input
                        type="checkbox"
                        checked={c.acknowledged}
                        onChange={() => toggleAcknowledged(c.key)}
                      />
                      I have no {c.label.toLowerCase()} to add
                    </label>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </main>
  );
}
