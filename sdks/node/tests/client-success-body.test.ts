/**
 * A 2xx means the server accepted the request, so whatever its body looks
 * like the SDK must not send it again.
 *
 *   - An empty 2xx body (what contact/leads/device POSTs return) resolves.
 *   - A non-JSON 2xx body raises PARSE_ERROR once, with no retry.
 *   - A 2xx body that fails mid-read raises NETWORK_ERROR once, with no retry.
 *
 * Before this, `response.json()` threw on both, the catch block treated the
 * SyntaxError as a network failure, and a single contact message was POSTed
 * four times before failing with NETWORK_ERROR.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  Cognitum,
  CognitumError,
  HttpClient,
  NetworkError,
  ParseError,
} from "../src/index.js";

function stubFetch(body: string, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function http(): HttpClient {
  return new HttpClient({ apiKey: "test-key", baseUrl: "http://mock.invalid", retries: 3 });
}

function client(): Cognitum {
  return new Cognitum({ apiKey: "test-key", baseUrl: "http://mock.invalid", retries: 3 });
}

const message = { name: "Ada", email: "ada@example.com", message: "hello" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("HttpClient 2xx bodies", () => {
  it("resolves an empty 200 body without re-sending the POST", async () => {
    const fetchMock = stubFetch("");
    await expect(client().contact.send(message)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ContactResource.send() discards the client's return value, so assert
  // what HttpClient.request itself resolves to.
  it("HttpClient.request resolves undefined for an empty 200 body", async () => {
    const fetchMock = stubFetch("");
    await expect(http().request("POST", "/sendContactEmail", message)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("HttpClient.request resolves undefined for a whitespace-only 201 body", async () => {
    const fetchMock = stubFetch("\n", 201);
    await expect(http().request("POST", "/sendContactEmail", message)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("raises NETWORK_ERROR once when a 200 body fails mid-read", async () => {
    const fetchMock = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new TypeError("terminated"));
        },
      });
      return new Response(body, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const err = await http()
      .request("POST", "/sendContactEmail", message)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as CognitumError).code).toBe("NETWORK_ERROR");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("raises PARSE_ERROR for a non-JSON 200 body and does not retry", async () => {
    const fetchMock = stubFetch("<html>OK</html>");
    const err = await client().contact.send(message).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ParseError);
    expect(err).toBeInstanceOf(CognitumError);
    expect((err as CognitumError).code).toBe("PARSE_ERROR");
    expect((err as Error).message).toContain("HTTP 200");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still parses a JSON 200 body", async () => {
    stubFetch(JSON.stringify({ status: "ok" }));
    await expect(client().health()).resolves.toEqual({ status: "ok" });
  });
});
