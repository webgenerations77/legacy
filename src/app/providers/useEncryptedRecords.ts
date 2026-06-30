"use client";

import { useEffect, useState, useCallback, useRef } from "react";
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
  const { resource, listKey, noun } = opts;
  const saveError = opts.saveError ?? "We couldn't save that. Please try again.";
  const router = useRouter();
  const { masterKey } = useKey();
  const [items, setItems] = useState<EncryptedRecordItem<T>[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  // Hold serialize/parse in refs so callers may pass inline lambdas without
  // destabilizing the load/add callbacks. If these functions sat in the
  // dependency arrays, a new inline reference each render would recreate
  // `load`, rerun the load effect, and cause an infinite refetch loop.
  const serializeRef = useRef(opts.serialize);
  const parseRef = useRef(opts.parse);
  serializeRef.current = opts.serialize;
  parseRef.current = opts.parse;

  const load = useCallback(async () => {
    if (!masterKey) return;
    setError("");
    const data = await api.listRecords(resource);
    const rows = (data[listKey] ?? []) as EncryptedRow[];
    const decrypted = await Promise.all(
      rows.map(async (r) => {
        try {
          return {
            id: r.id,
            value: parseRef.current(await decryptItem(masterKey, r.ciphertext, r.iv)),
          };
        } catch {
          return { id: r.id, value: null };
        }
      }),
    );
    setItems(decrypted);
    setLoaded(true);
  }, [masterKey, resource, listKey]);

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
        const { ciphertext, iv } = await encryptItem(masterKey, serializeRef.current(value));
        await api.addRecord(resource, ciphertext, iv);
        await load();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : saveError);
        return false;
      }
    },
    [masterKey, resource, load, saveError],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      setError("");
      try {
        await api.deleteRecord(resource, id);
        await load();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "We couldn't delete that.");
        return false;
      }
    },
    [resource, load],
  );

  return { items, error, loaded, add, remove, masterKey };
}
