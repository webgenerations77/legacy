import { describe, it, expect } from "vitest";
import { NextResponse } from "next/server";
import { readJsonBody, noStore, MAX_JSON_BODY } from "./http";

function jsonReq(body: unknown) {
  return new Request("http://localhost/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("readJsonBody", () => {
  it("parses a valid JSON object", async () => {
    expect(await readJsonBody(jsonReq({ a: 1 }))).toEqual({ a: 1 });
  });

  it("400 on malformed JSON", async () => {
    const out = await readJsonBody(jsonReq("not json"));
    expect(out).toBeInstanceOf(NextResponse);
    expect((out as NextResponse).status).toBe(400);
  });

  it("400 on a non-object JSON body", async () => {
    expect(((await readJsonBody(jsonReq(JSON.stringify(42)))) as NextResponse).status).toBe(400);
  });

  it("413 (before reading) when Content-Length exceeds maxBytes", async () => {
    let read = false;
    const stub = {
      headers: { get: (h: string) => (h.toLowerCase() === "content-length" ? "999999" : null) },
      text: async () => { read = true; return "{}"; },
    } as unknown as Request;
    const out = await readJsonBody(stub, 1000);
    expect((out as NextResponse).status).toBe(413);
    expect(read).toBe(false);
  });

  it("413 when the actual body exceeds maxBytes with no Content-Length", async () => {
    const stub = {
      headers: { get: () => null },
      text: async () => "a".repeat(50),
    } as unknown as Request;
    expect(((await readJsonBody(stub, 10)) as NextResponse).status).toBe(413);
  });

  it("413 measures UTF-8 bytes, not code units, for multi-byte bodies", async () => {
    const body = "猫".repeat(20); // 20 code units, 60 UTF-8 bytes
    expect(body.length).toBeLessThanOrEqual(30);
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(30);
    const stub = {
      headers: { get: () => null },
      text: async () => body,
    } as unknown as Request;
    const out = await readJsonBody(stub, 30);
    expect(out).toBeInstanceOf(NextResponse);
    expect((out as NextResponse).status).toBe(413);
  });

  it("defaults the ceiling to MAX_JSON_BODY", async () => {
    expect(MAX_JSON_BODY).toBe(256 * 1024);
    expect(await readJsonBody(jsonReq({ ok: true }))).toEqual({ ok: true });
  });
});

describe("noStore", () => {
  it("sets Cache-Control: no-store", () => {
    expect(noStore(NextResponse.json({ a: 1 })).headers.get("cache-control")).toBe("no-store");
  });
});
