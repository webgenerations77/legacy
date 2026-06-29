"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { useKey } from "@/app/providers/KeyProvider";
import { encryptItem, decryptItem } from "@/lib/crypto";
import { parseAccount, type Account } from "@/lib/account";
import { parseBill, type Bill } from "@/lib/bill";
import { parseLoan, type Loan } from "@/lib/loan";
import { parseBeneficiary, type Beneficiary } from "@/lib/beneficiary";
import {
  computeReadiness,
  serializeReadinessState,
  parseReadinessState,
  type ReadinessCategoryKey,
} from "@/lib/readiness";
import type { CryptoBytes } from "@/lib/crypto";

interface EncryptedRow {
  id: string;
  ciphertext: string;
  iv: string;
}

function rowsOf(data: Record<string, unknown>, key: string): EncryptedRow[] {
  return (data[key] ?? []) as EncryptedRow[];
}

// Decrypt + parse a list, silently dropping any row that fails to decrypt.
async function decryptList<T>(
  masterKey: CryptoBytes,
  rows: EncryptedRow[],
  parse: (json: string) => T,
): Promise<T[]> {
  const out: T[] = [];
  for (const r of rows) {
    try {
      out.push(parse(await decryptItem(masterKey, r.ciphertext, r.iv)));
    } catch {
      // undecryptable row — skip it
    }
  }
  return out;
}

export function useReadinessData() {
  const router = useRouter();
  const { masterKey } = useKey();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([]);
  const [vaultCount, setVaultCount] = useState(0);
  const [obituaryDraftPresent, setObituaryDraftPresent] = useState(false);
  const [acknowledgedEmpty, setAcknowledgedEmpty] = useState<ReadinessCategoryKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!masterKey) {
      router.replace("/unlock");
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const [acctRes, billRes, loanRes, beneRes, vaultRes, obit, stateRes] =
          await Promise.all([
            api.listRecords("accounts"),
            api.listRecords("bills"),
            api.listRecords("loans"),
            api.listRecords("beneficiaries"),
            api.listRecords("vault"),
            api.getObituary(),
            api.getReadinessState(),
          ]);

        const [a, b, l, be] = await Promise.all([
          decryptList<Account>(masterKey, rowsOf(acctRes, "accounts"), parseAccount),
          decryptList<Bill>(masterKey, rowsOf(billRes, "bills"), parseBill),
          decryptList<Loan>(masterKey, rowsOf(loanRes, "loans"), parseLoan),
          decryptList<Beneficiary>(
            masterKey,
            rowsOf(beneRes, "beneficiaries"),
            parseBeneficiary,
          ),
        ]);

        let ack: ReadinessCategoryKey[] = [];
        if (stateRes.state) {
          try {
            ack = parseReadinessState(
              await decryptItem(masterKey, stateRes.state.ciphertext, stateRes.state.iv),
            ).acknowledgedEmpty;
          } catch {
            ack = [];
          }
        }

        if (cancelled) return;
        setAccounts(a);
        setBills(b);
        setLoans(l);
        setBeneficiaries(be);
        setVaultCount(rowsOf(vaultRes, "items").length);
        setObituaryDraftPresent(Boolean(obit?.obituary?.draft?.trim()));
        setAcknowledgedEmpty(ack);
        setLoading(false);
      } catch {
        if (cancelled) return;
        setError("We couldn't load some of your records. Please try again.");
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [masterKey, router]);

  const report = useMemo(
    () =>
      computeReadiness({
        accounts,
        bills,
        loans,
        beneficiaries,
        vaultCount,
        obituaryDraftPresent,
        acknowledgedEmpty,
      }),
    [accounts, bills, loans, beneficiaries, vaultCount, obituaryDraftPresent, acknowledgedEmpty],
  );

  const toggleAcknowledged = useCallback(
    async (key: ReadinessCategoryKey) => {
      if (!masterKey) return;
      const prev = acknowledgedEmpty;
      const next = prev.includes(key)
        ? prev.filter((k) => k !== key)
        : [...prev, key];
      setAcknowledgedEmpty(next); // optimistic
      setError("");
      try {
        const { ciphertext, iv } = await encryptItem(
          masterKey,
          serializeReadinessState({ acknowledgedEmpty: next }),
        );
        await api.putReadinessState(ciphertext, iv);
      } catch {
        setAcknowledgedEmpty(prev); // revert on failure
        setError("We couldn't save that change. Please try again.");
      }
    },
    [masterKey, acknowledgedEmpty],
  );

  return { report, loading, error, masterKey, toggleAcknowledged };
}
