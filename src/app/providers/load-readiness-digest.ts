"use client";

import { api } from "@/lib/api-client";
import { decryptItem, type CryptoBytes } from "@/lib/crypto";
import { parseAccount, type Account } from "@/lib/account";
import { parseBill, type Bill } from "@/lib/bill";
import { parseLoan, type Loan } from "@/lib/loan";
import { parseBeneficiary, type Beneficiary } from "@/lib/beneficiary";
import {
  computeReadiness,
  parseReadinessState,
  type ReadinessCategoryKey,
} from "@/lib/readiness";
import { buildReadinessDigest, type ReadinessDigest } from "@/lib/assistant/records-digest";

interface EncryptedRow {
  id: string;
  ciphertext: string;
  iv: string;
}

function rowsOf(data: Record<string, unknown>, key: string): EncryptedRow[] {
  return (data[key] ?? data.items ?? []) as EncryptedRow[];
}

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

export async function loadReadinessDigest(masterKey: CryptoBytes): Promise<ReadinessDigest> {
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

  const [accounts, bills, loans, beneficiaries] = await Promise.all([
    decryptList<Account>(masterKey, rowsOf(acctRes, "accounts"), parseAccount),
    decryptList<Bill>(masterKey, rowsOf(billRes, "bills"), parseBill),
    decryptList<Loan>(masterKey, rowsOf(loanRes, "loans"), parseLoan),
    decryptList<Beneficiary>(masterKey, rowsOf(beneRes, "beneficiaries"), parseBeneficiary),
  ]);

  let acknowledgedEmpty: ReadinessCategoryKey[] = [];
  if (stateRes.state) {
    try {
      acknowledgedEmpty = parseReadinessState(
        await decryptItem(masterKey, stateRes.state.ciphertext, stateRes.state.iv),
      ).acknowledgedEmpty;
    } catch {
      acknowledgedEmpty = [];
    }
  }

  const report = computeReadiness({
    accounts,
    bills,
    loans,
    beneficiaries,
    vaultCount: rowsOf(vaultRes, "vault").length,
    obituaryDraftPresent: Boolean(obit?.obituary?.draft?.trim()),
    acknowledgedEmpty,
  });
  return buildReadinessDigest(report);
}
