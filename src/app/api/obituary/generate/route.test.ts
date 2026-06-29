import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUserId = vi.fn();
const streamText = vi.fn();
const anthropic = vi.fn((..._a: unknown[]) => "mock-model");

vi.mock("@/lib/route-auth", () => ({
  requireUserId: (...a: unknown[]) => requireUserId(...a),
}));
vi.mock("ai", () => ({
  streamText: (...a: unknown[]) => streamText(...a),
}));
vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: (...a: unknown[]) => anthropic(...a),
}));

import { POST, MODEL_ID } from "@/app/api/obituary/generate/route";

const intake = {
  subjectName: "Jane Doe",
  dateOfBirth: "",
  dateOfDeath: "",
  placeOrHometown: "",
  lifeStory: "A good life.",
  family: "",
  achievements: "",
  hobbies: "",
  tone: "Warm",
  length: "Standard",
  additionalWishes: "",
};

function postReq(body: unknown) {
  return new Request("http://localhost/api/obituary/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  requireUserId.mockReset();
  streamText.mockReset();
  anthropic.mockClear();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe("obituary generate route", () => {
  it("returns 401 when unauthenticated", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await POST(postReq(intake))).status).toBe(401);
    expect(streamText).not.toHaveBeenCalled();
  });

  it("returns 400 when subjectName is missing", async () => {
    requireUserId.mockResolvedValue("user-1");
    expect(
      (await POST(postReq({ ...intake, subjectName: "  " }))).status,
    ).toBe(400);
    expect(streamText).not.toHaveBeenCalled();
  });

  it("returns 500 when the API key is not configured", async () => {
    requireUserId.mockResolvedValue("user-1");
    delete process.env.ANTHROPIC_API_KEY;
    expect((await POST(postReq(intake))).status).toBe(500);
    expect(streamText).not.toHaveBeenCalled();
  });

  it("streams a draft from the built prompt when authenticated", async () => {
    requireUserId.mockResolvedValue("user-1");
    streamText.mockReturnValue({
      toTextStreamResponse: () => new Response("Jane Doe lived well."),
    });
    const res = await POST(postReq(intake));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Jane Doe lived well.");
    expect(anthropic).toHaveBeenCalledWith(MODEL_ID);
    const arg = streamText.mock.calls[0][0] as {
      model: unknown;
      system: string;
      prompt: string;
      onError: unknown;
    };
    expect(arg.model).toBe("mock-model");
    expect(arg.system.toLowerCase()).toContain("warm");
    expect(arg.prompt).toContain("Name: Jane Doe");
    // Generation errors stream after the 200; onError logs them server-side.
    expect(typeof arg.onError).toBe("function");
  });
});
