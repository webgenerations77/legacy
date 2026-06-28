import { NextResponse } from "next/server";

/** Parse a JSON request body. Returns the parsed object, or a 400 NextResponse on malformed JSON. */
export async function readJsonBody(req: Request): Promise<Record<string, unknown> | NextResponse> {
  try {
    const body = await req.json();
    if (body === null || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }
    return body as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
}
