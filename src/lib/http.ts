import { NextResponse } from "next/server";

/** Default ceiling for small JSON request bodies (records, auth, survivor routes). */
export const MAX_JSON_BODY = 256 * 1024; // 256 KB

const tooLarge = () => NextResponse.json({ error: "Request too large." }, { status: 413 });
const badBody = () => NextResponse.json({ error: "Invalid request body." }, { status: 400 });

/**
 * Parse a JSON request body with a hard size ceiling. Returns the parsed object,
 * a 413 NextResponse when the body exceeds `maxBytes` (checked against the
 * Content-Length header first, then the actual read to defend against an absent
 * or lying header), or a 400 NextResponse on malformed JSON.
 */
export async function readJsonBody(
  req: Request,
  maxBytes: number = MAX_JSON_BODY,
): Promise<Record<string, unknown> | NextResponse> {
  const declared = req.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) return tooLarge();

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return badBody();
  }
  if (raw.length > maxBytes) return tooLarge();

  try {
    const body = JSON.parse(raw);
    if (body === null || typeof body !== "object") return badBody();
    return body as Record<string, unknown>;
  } catch {
    return badBody();
  }
}

/** Mark a response carrying ciphertext as uncacheable. */
export function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}
