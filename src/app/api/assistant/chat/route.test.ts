import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getSessionUserId = vi.fn();
const streamTextMock = vi.fn();

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "sid-123" }) }),
}));
vi.mock("@/lib/auth", () => ({
  getSessionUserId: (...args: unknown[]) => getSessionUserId(...args),
}));
vi.mock("@ai-sdk/anthropic", () => ({ anthropic: (id: string) => ({ modelId: id }) }));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: (...args: unknown[]) => streamTextMock(...args),
}));

import { POST } from "@/app/api/assistant/chat/route";

function postReq(body: unknown) {
  return new Request("http://localhost/api/assistant/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  getSessionUserId.mockReset();
  streamTextMock.mockReset();
  streamTextMock.mockReturnValue({ toUIMessageStreamResponse: () => new Response("stream") });
  process.env.ANTHROPIC_API_KEY = "test-key";
});
afterEach(() => {
  process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
});

describe("POST /api/assistant/chat", () => {
  it("returns 401 when unauthenticated and never calls the model", async () => {
    getSessionUserId.mockResolvedValue(null);
    const res = await POST(postReq({ messages: [] }));
    expect(res.status).toBe(401);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("returns 500 when ANTHROPIC_API_KEY is absent", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    delete process.env.ANTHROPIC_API_KEY;
    const res = await POST(postReq({ messages: [] }));
    expect(res.status).toBe(500);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("streams a response and wires the proposeRecord tool when authenticated", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    const res = await POST(postReq({ messages: [] }));
    expect(res.status).toBe(200);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const arg = streamTextMock.mock.calls[0][0] as {
      system: string;
      tools: { proposeRecord?: unknown };
    };
    expect(typeof arg.system).toBe("string");
    expect(arg.tools.proposeRecord).toBeDefined();
  });

  it("appends editing context to the system prompt when editContext is present", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    await POST(postReq({
      messages: [],
      editContext: { type: "loan", currentFields: { lender: "Wells Fargo", interestRate: "6.1" } },
    }));
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const arg = streamTextMock.mock.calls[0][0] as { system: string };
    expect(arg.system).toContain("editing an existing loan");
    expect(arg.system).toContain("Wells Fargo");
  });

  it("wires the readRecords tool alongside proposeRecord", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    await POST(postReq({ messages: [] }));
    const arg = streamTextMock.mock.calls[0][0] as {
      tools: { proposeRecord?: unknown; readRecords?: unknown };
    };
    expect(arg.tools.proposeRecord).toBeDefined();
    expect(arg.tools.readRecords).toBeDefined();
  });

  it("appends the readiness summary to the system prompt when readinessDigest is present", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    await POST(postReq({
      messages: [],
      readinessDigest: { overall: 25, categories: [{ key: "loans", label: "Loans", status: "empty" }] },
    }));
    const arg = streamTextMock.mock.calls[0][0] as { system: string };
    expect(arg.system).toContain("Readiness summary");
    expect(arg.system).toContain("Loans");
  });
});
