"use client";

import { useState, useRef } from "react";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { useDocuments } from "@/app/providers/useDocuments";
import { formatFileSize, MAX_FILE_BYTES } from "@/lib/document";

export default function DocumentsPage() {
  const { items, error, loaded, upload, download, remove, masterKey } = useDocuments();
  const [busy, setBusy] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    await upload(file);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  if (!masterKey) return null;

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Documents</h1>
        <p className="subtle">
          Each file is encrypted on your device before it leaves. Limit{" "}
          {formatFileSize(MAX_FILE_BYTES)} per file.
        </p>

        <label htmlFor="file">Upload a document</label>
        <input id="file" ref={inputRef} type="file" onChange={onChange} disabled={busy} />
        {busy && <p className="subtle">Encrypting and uploading…</p>}

        {error && <p className="error">{error}</p>}

        {loaded && items.length === 0 && (
          <p className="subtle">No documents yet. Upload your first above.</p>
        )}
        {items.some((it) => it.meta === null) && (
          <p className="subtle">We couldn&apos;t unlock some documents.</p>
        )}

        {items.map(
          (it) =>
            it.meta && (
              <div className="item" key={it.id}>
                <strong>{it.meta.filename || "Untitled"}</strong>
                <div className="meta">
                  {it.meta.contentType || "file"} · {formatFileSize(it.meta.size)}
                </div>
                <div className="row">
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() => download(it.id, it.meta!)}
                  >
                    Download
                  </button>
                  {confirmingId === it.id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmingId(null);
                          remove(it.id);
                        }}
                      >
                        Confirm delete
                      </button>
                      <button
                        type="button"
                        className="linkbtn"
                        onClick={() => setConfirmingId(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="linkbtn"
                      onClick={() => setConfirmingId(it.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ),
        )}
      </div>
    </main>
  );
}
