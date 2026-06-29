"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { useKey } from "@/app/providers/KeyProvider";
import { encryptItem, decryptItem } from "@/lib/crypto";

export interface EncryptedRecordItem<T> {
  id: string;
  value: T | null; // null = this row failed to decrypt
}

interface EncryptedRow {
  id: string;
  ciphertext: string;
  iv: string;
}

export function useEncryptedRecords<T>(opts: {
  resource: string;
  listKey: string;
  serialize: (value: T) => string;
  parse: (json: string) => T;
  noun: string;
  saveError?: string;
}) {
  const { resource, listKey, serialize, parse, noun } = opts;
  const saveError = opts.saveError ?? "We couldn't save that. Please try again.";
  const router = useRouter();
  const { masterKey } = useKey();
  const [items, setItems] = useState<EncryptedRecordItem<T>[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!masterKey) return;
    setError("");
    const data = await api.listRecords(resource);
    const rows = (data[listKey] ?? []) as EncryptedRow[];
    const decrypted = await Promise.all(
      rows.map(async (r) => {
        try {
          return { id: r.id, value: parse(await decryptItem(masterKey, r.ciphertext, r.iv)) };
        } catch {
          return { id: r.id, value: null };
        }
      }),
    );
    setItems(decrypted);
    setLoaded(true);
  }, [masterKey, resource, listKey, parse]);

  useEffect(() => {
    if (!masterKey) {
      router.replace("/unlock");
      return;
    }
    load().catch(() =>
      setError(`We couldn't load your ${noun}. Please try unlocking again.`),
    );
  }, [masterKey, load, router, noun]);

  const add = useCallback(
    async (value: T): Promise<boolean> => {
      if (!masterKey) return false;
      setError("");
      try {
        const { ciphertext, iv } = await encryptItem(masterKey, serialize(value));
        await api.addRecord(resource, ciphertext, iv);
        await load();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : saveError);
        return false;
      }
    },
    [masterKey, resource, serialize, load, saveError],
  );

  return { items, error, loaded, add, masterKey };
}
