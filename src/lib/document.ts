export interface DocumentMeta {
  filename: string;
  contentType: string;
  size: number; // plaintext byte length, for display
}

/** Largest plaintext file we accept (validated in the browser before encrypting). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Server-side guard on stored ciphertext length (base64 of ~5 MB + AES overhead, with margin). */
export const MAX_CONTENT_CIPHERTEXT_CHARS = 8 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export function isAllowedType(contentType: string): boolean {
  return ALLOWED_CONTENT_TYPES.has(contentType);
}

export function serializeMeta(meta: DocumentMeta): string {
  return JSON.stringify({
    filename: meta.filename,
    contentType: meta.contentType,
    size: meta.size,
  });
}

export function parseMeta(json: string): DocumentMeta {
  const o = JSON.parse(json) as Record<string, unknown>;
  if (
    typeof o.filename !== "string" ||
    typeof o.contentType !== "string" ||
    typeof o.size !== "number"
  ) {
    throw new Error("Malformed document metadata.");
  }
  return { filename: o.filename, contentType: o.contentType, size: o.size };
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
