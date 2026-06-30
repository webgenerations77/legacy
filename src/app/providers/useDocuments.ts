"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { useKey } from "@/app/providers/KeyProvider";
import {
  encryptItem,
  decryptItem,
  encryptBytes,
  decryptBytes,
  type CryptoBytes,
} from "@/lib/crypto";
import {
  type DocumentMeta,
  serializeMeta,
  parseMeta,
  isAllowedType,
  formatFileSize,
  MAX_FILE_BYTES,
} from "@/lib/document";

export interface DocumentItem {
  id: string;
  meta: DocumentMeta | null; // null = this row failed to decrypt
}

function saveBytes(bytes: CryptoBytes, filename: string, contentType: string) {
  const blob = new Blob([bytes], { type: contentType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "document";
  a.click();
  URL.revokeObjectURL(url);
}

export function useDocuments() {
  const router = useRouter();
  const { masterKey } = useKey();
  const [items, setItems] = useState<DocumentItem[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!masterKey) return;
    setError("");
    const { documents } = await api.listDocuments();
    const decrypted = await Promise.all(
      documents.map(async (d) => {
        try {
          return { id: d.id, meta: parseMeta(await decryptItem(masterKey, d.metaCiphertext, d.metaIv)) };
        } catch {
          return { id: d.id, meta: null };
        }
      }),
    );
    setItems(decrypted);
    setLoaded(true);
  }, [masterKey]);

  useEffect(() => {
    if (!masterKey) {
      router.replace("/unlock");
      return;
    }
    load().catch(() =>
      setError("We couldn't load your documents. Please try unlocking again."),
    );
  }, [masterKey, load, router]);

  const upload = useCallback(
    async (file: File): Promise<boolean> => {
      if (!masterKey) return false;
      setError("");
      if (file.size > MAX_FILE_BYTES) {
        setError(`That file is ${formatFileSize(file.size)}. The limit is ${formatFileSize(MAX_FILE_BYTES)}.`);
        return false;
      }
      if (!isAllowedType(file.type)) {
        setError("That file type isn't supported.");
        return false;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer()) as CryptoBytes;
        const content = await encryptBytes(masterKey, bytes);
        const meta = await encryptItem(
          masterKey,
          serializeMeta({ filename: file.name, contentType: file.type, size: file.size }),
        );
        await api.addDocument({
          metaCiphertext: meta.ciphertext,
          metaIv: meta.iv,
          contentCiphertext: content.ciphertext,
          contentIv: content.iv,
        });
        await load();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "We couldn't save that file.");
        return false;
      }
    },
    [masterKey, load],
  );

  const download = useCallback(
    async (id: string, meta: DocumentMeta): Promise<void> => {
      if (!masterKey) return;
      setError("");
      try {
        const { contentCiphertext, contentIv } = await api.getDocumentContent(id);
        const bytes = await decryptBytes(masterKey, contentCiphertext, contentIv);
        saveBytes(bytes, meta.filename, meta.contentType);
      } catch (err) {
        setError(err instanceof Error ? err.message : "We couldn't open that file.");
      }
    },
    [masterKey],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      setError("");
      try {
        await api.deleteDocument(id);
        await load();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "We couldn't delete that.");
        return false;
      }
    },
    [load],
  );

  return { items, error, loaded, upload, download, remove, masterKey };
}
