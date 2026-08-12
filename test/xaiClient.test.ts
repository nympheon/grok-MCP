import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchRequest } from "../src/types.js";
import {
  buildToolEntry,
  type CallResponsesInput,
  callResponses,
  readBoundedText,
  resolveModel,
} from "../src/xaiClient.js";

const maximumBytes = 2 * 1024 * 1024;

function validInput(
  fetchImpl: typeof fetch,
  request: SearchRequest = { tool: "x_search", query: "current Cloudflare news" },
): CallResponsesInput {
  return {
    accessToken: "SENSITIVE_ACCESS_TOKEN",
    model: "grok-4.5",
    request,
    fetchImpl,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveModel", () => {
  it("uses a safe configured model and defaults to grok-4.5", () => {
    expect(resolveModel(" grok-4.5 ")).toBe("grok-4.5");
    expect(resolveModel("grok-future-stable")).toBe("grok-future-stable");
    expect(resolveModel("untrusted/model")).toBe("grok-4.5");
    expect(resolveModel()).toBe("grok-4.5");
  });
});

describe("buildToolEntry", () => {
  it("accepts 20 X handles and maps current media-understanding options", () => {
    const handles = [
      "user01",
      "user02",
      "user03",
      "user04",
      "user05",
      "user06",
      "user07",
      "user08",
      "user09",
      "user10",
      "user11",
      "user12",
      "user13",
      "user14",
      "user15",
      "user16",
      "user17",
      "user18",
      "user19",
      "user20",
    ];
    expect(
      buildToolEntry({
        tool: "x_search",
        query: "q",
        allowedXHandles: handles,
        fromDate: "2026-01-01",
        toDate: "2026-08-12",
        enableImageUnderstanding: true,
        enableVideoUnderstanding: true,
      }),
    ).toEqual({
      type: "x_search",
      allowed_x_handles: handles,
      from_date: "2026-01-01",
      to_date: "2026-08-12",
      enable_image_understanding: true,
      enable_video_understanding: true,
    });
  });

  it("builds web_search filters and current image options", () => {
    expect(
      buildToolEntry({
        tool: "web_search",
        query: "q",
        allowedDomains: ["developers.cloudflare.com"],
        enableImageSearch: true,
        enableImageUnderstanding: true,
      }),
    ).toEqual({
      type: "web_search",
      filters: {
        allowed_domains: ["developers.cloudflare.com"],
      },
      enable_image_search: true,
      enable_image_understanding: true,
    });
  });

  it("rejects a 21st X handle and a sixth web domain", () => {
    expect(() =>
      buildToolEntry({
        tool: "x_search",
        query: "q",
        allowedXHandles: Array.from({ length: 21 }, (_, index) => `user${index + 1}`),
      }),
    ).toThrowError(expect.objectContaining({ code: "BAD_REQUEST" }));
    expect(() =>
      buildToolEntry({
        tool: "web_search",
        query: "q",
        allowedDomains: ["1.test", "2.test", "3.test", "4.test", "5.test", "6.test"],
      }),
    ).toThrowError(expect.objectContaining({ code: "BAD_REQUEST" }));
  });

  it("rejects simultaneous allow and exclude filters", () => {
    expect(() =>
      buildToolEntry({
        tool: "x_search",
        query: "q",
        allowedXHandles: ["wanted"],
        excludedXHandles: ["blocked"],
      }),
    ).toThrowError(expect.objectContaining({ code: "BAD_REQUEST" }));
    expect(() =>
      buildToolEntry({
        tool: "web_search",
        query: "q",
        allowedDomains: ["allowed.test"],
        excludedDomains: ["blocked.test"],
      }),
    ).toThrowError(expect.objectContaining({ code: "BAD_REQUEST" }));
  });

  it("rejects malformed, impossible, and reversed date ranges", () => {
    for (const request of [
      { tool: "x_search" as const, query: "q", fromDate: "2026/01/01" },
      { tool: "x_search" as const, query: "q", fromDate: "2026-02-30" },
      {
        tool: "x_search" as const,
        query: "q",
        fromDate: "2026-08-13",
        toDate: "2026-08-12",
      },
    ]) {
      expect(() => buildToolEntry(request)).toThrowError(
        expect.objectContaining({ code: "BAD_REQUEST" }),
      );
    }
  });

  it("rejects an invalid query", () => {
    expect(() => buildToolEntry({ tool: "x_search", query: "x".repeat(8_001) })).toThrowError(
      expect.objectContaining({ code: "BAD_REQUEST" }),
    );
  });
});

describe("readBoundedText", () => {
  it("rejects a declared or streamed response larger than 2 MiB", async () => {
    const declared = new Response("small", {
      headers: { "content-length": String(maximumBytes + 1) },
    });
    await expect(readBoundedText(declared, maximumBytes)).rejects.toMatchObject({
      code: "UPSTREAM_TOO_LARGE",
    });

    const streamed = new Response("x".repeat(maximumBytes + 1));
    await expect(readBoundedText(streamed, maximumBytes)).rejects.toMatchObject({
      code: "UPSTREAM_TOO_LARGE",
    });
  });
});

describe("callResponses", () => {
  it("sends only the bounded Responses request and reads the current raw response shape", async () => {
    let sentBody: unknown;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return Response.json({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "answer", annotations: [] }],
          },
        ],
        citations: ["https://example.com/a", "https://example.com/a", "https://example.com/b"],
      });
    }) as unknown as typeof fetch;

    const result = await callResponses(validInput(fetchImpl));
    expect(sentBody).toEqual({
      model: "grok-4.5",
      input: [{ role: "user", content: "current Cloudflare news" }],
      tools: [{ type: "x_search" }],
    });
    expect(result).toEqual({
      text: "answer",
      citations: ["https://example.com/a", "https://example.com/b"],
      model: "grok-4.5",
    });
  });

  it("rejects the removed top-level output_text response fallback", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ output_text: "legacy-only", citations: [] }),
    ) as unknown as typeof fetch;

    await expect(callResponses(validInput(fetchImpl))).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      message: expect.stringContaining("no output text"),
    });
  });

  it("extracts and deduplicates citations from the real Responses shape", async () => {
    const body = {
      output: [
        { type: "reasoning", summary: [] },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "first",
              annotations: [
                { type: "url_citation", url: "https://x.com/status/1" },
                { type: "url_citation", url: "https://x.com/status/1" },
              ],
            },
            { type: "output_text", text: "second", annotations: [] },
          ],
        },
      ],
    };
    const fetchImpl = vi.fn(async () => Response.json(body)) as unknown as typeof fetch;
    await expect(callResponses(validInput(fetchImpl))).resolves.toEqual({
      text: "first\nsecond",
      citations: ["https://x.com/status/1"],
      model: "grok-4.5",
    });
  });

  it("maps 401 to EXPIRED without exposing the body", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: "SECRET_RESPONSE_BODY" }, { status: 401 }),
    ) as unknown as typeof fetch;
    const promise = callResponses(validInput(fetchImpl));
    await expect(promise).rejects.toMatchObject({ code: "EXPIRED" });
    await expect(promise).rejects.not.toThrow(/SECRET_RESPONSE_BODY/);
    await expect(promise).rejects.toThrow(/Worker administration page/);
    await expect(promise).rejects.not.toThrow(/grok_login/);
  });

  it("maps 403 with only a bounded upstream code", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        {
          code: "personal-team-blocked:spending-limit",
          error: "SECRET_RESPONSE_BODY",
        },
        { status: 403 },
      ),
    ) as unknown as typeof fetch;
    const promise = callResponses(validInput(fetchImpl));
    await expect(promise).rejects.toMatchObject({
      code: "FORBIDDEN_403",
      message: expect.stringContaining("personal-team-blocked:spending-limit"),
    });
    await expect(promise).rejects.not.toThrow(/SECRET_RESPONSE_BODY/);
  });

  it("maps 429 and caps Retry-After at one hour", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { error: "SECRET_RESPONSE_BODY" },
        { status: 429, headers: { "retry-after": "999999" } },
      ),
    ) as unknown as typeof fetch;
    await expect(callResponses(validInput(fetchImpl))).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: expect.stringContaining("3600"),
    });
  });

  it("does not expose a raw upstream marker for other HTTP failures", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: "SECRET_RESPONSE_BODY" }, { status: 500 }),
    ) as unknown as typeof fetch;
    const promise = callResponses(validInput(fetchImpl));
    await expect(promise).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    await expect(promise).rejects.not.toThrow(/SECRET_RESPONSE_BODY/);
  });

  it("maps an aborted request to UPSTREAM_TIMEOUT", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("timed out", "AbortError")),
            { once: true },
          );
        }),
    ) as unknown as typeof fetch;
    const assertion = expect(callResponses(validInput(fetchImpl))).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(180_000);
    await assertion;
  });

  it("maps invalid success JSON to UPSTREAM_ERROR", async () => {
    const fetchImpl = vi.fn(async () => new Response("not-json")) as unknown as typeof fetch;
    await expect(callResponses(validInput(fetchImpl))).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });
});
