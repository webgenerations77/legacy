import { describe, it, expect } from "vitest";
import {
  serializeMeta,
  parseMeta,
  formatFileSize,
  isAllowedType,
  MAX_FILE_BYTES,
  MAX_META_CIPHERTEXT_CHARS,
  type DocumentMeta,
} from "./document";

describe("document meta", () => {
  it("round-trips serialize/parse", () => {
    const meta: DocumentMeta = { filename: "will.pdf", contentType: "application/pdf", size: 1234 };
    expect(parseMeta(serializeMeta(meta))).toEqual(meta);
  });

  it("parse throws on a malformed shape", () => {
    expect(() => parseMeta(JSON.stringify({ filename: "x" }))).toThrow();
    expect(() => parseMeta("not json")).toThrow();
  });

  it("formatFileSize is human readable", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(812)).toBe("812 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1.4 * 1024 * 1024)).toBe("1.4 MB");
  });

  it("allows documents/images and rejects others", () => {
    expect(isAllowedType("application/pdf")).toBe(true);
    expect(isAllowedType("image/png")).toBe(true);
    expect(isAllowedType("application/x-msdownload")).toBe(false);
    expect(isAllowedType("")).toBe(false);
  });

  it("exposes a 5 MB cap", () => {
    expect(MAX_FILE_BYTES).toBe(5 * 1024 * 1024);
  });

  it("exposes a 64 KB metadata ciphertext cap", () => {
    expect(MAX_META_CIPHERTEXT_CHARS).toBe(64 * 1024);
  });
});
