/**
 * Micro-benchmark: SSE stream parser + envelope decode overhead for
 * `MetaLlmClient.chat.completionsStream()` (ADR-0024a §D5, issue #58 /
 * PR #88/#95's streaming work).
 *
 * Measures two things against a local, dependency-free `node:http` mock
 * server emitting a bounded, deterministic sequence of OpenAI-shaped SSE
 * chunks:
 *   1. time-to-first-event — wall clock from calling
 *      `chat.completionsStream()` to the first `for await` iteration
 *      resolving with a value (dominated by the local HTTP round trip,
 *      not the parser);
 *   2. steady-state throughput — events/sec once bytes are flowing,
 *      isolating the `SseParser.feed` + OpenAI SSE decode + envelope-build
 *      cost per event.
 *
 * `MetaProxyClient`'s streaming (`../src/meta-proxy/stream/`) is built on
 * the same generic `../src/sse/parser.js` (see that module's doc comment),
 * so this bench's steady-state parser numbers are representative of Meta
 * Proxy's streaming overhead too, not just Meta LLM's.
 *
 * Targets (engineering estimates, NOT ADR-mandated — no ADR cites a
 * streaming-latency number the way ADR-0005 cites <1ms p50 for the seed
 * client):
 *   - time-to-first-event p50 < 5 ms against a local mock (should be
 *     dominated by the loopback HTTP round trip, not the parser);
 *   - steady-state throughput > 20,000 events/sec (< 50 µs/event for
 *     SSE-frame parse + OpenAI JSON decode + envelope construction).
 *
 * Usage:
 *   npx tsx bench/agentic-streaming-bench.ts
 *   # or, without tsx:
 *   node --experimental-strip-types bench/agentic-streaming-bench.ts
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { StaticApiKeyCredentialProvider } from "../dist/agentic/index.js";
import { MetaLlmClient } from "../dist/meta-llm/index.js";

const NUM_CONTENT_CHUNKS = 300;
const ITERS = 60;

function buildSseBody(): string {
  let body = "";
  body +=
    'data: {"id":"chatcmpl-bench","object":"chat.completion.chunk","created":1,"model":"m",' +
    '"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n';
  for (let i = 0; i < NUM_CONTENT_CHUNKS; i += 1) {
    body += `data: {"choices":[{"index":0,"delta":{"content":"chunk-${i} "},"finish_reason":null}]}\n\n`;
  }
  body +=
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],' +
    '"usage":{"prompt_tokens":10,"completion_tokens":300,"total_tokens":310}}\n\n';
  body += "data: [DONE]\n\n";
  return body;
}

function startMock(body: string): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.statusCode = 200;
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function chatRequest() {
  return {
    model: "meta-llm-large",
    messages: [{ role: "user" as const, content: "hello" }],
  };
}

async function main() {
  const body = buildSseBody();
  const { server, url } = await startMock(body);

  const client = new MetaLlmClient({
    baseUrl: url,
    allowInsecureHttp: true,
    credentialProvider: new StaticApiKeyCredentialProvider({
      apiKey: "sk-bench-canary",
      product: "meta-llm",
      normalizedOrigin: url,
      audience: url,
    }),
  });

  // Warmup.
  for (let i = 0; i < 5; i += 1) {
    for await (const _envelope of client.chat.completionsStream(chatRequest())) {
      /* drain */
    }
  }

  const firstEventSamples: number[] = [];
  const eventsPerSecSamples: number[] = [];
  const eventCounts: number[] = [];

  for (let i = 0; i < ITERS; i += 1) {
    const t0 = performance.now();
    let count = 0;
    let firstEvent: number | undefined;
    let last = t0;

    for await (const _envelope of client.chat.completionsStream(chatRequest())) {
      count += 1;
      const now = performance.now();
      if (firstEvent === undefined) firstEvent = now - t0;
      last = now;
    }

    const firstEventMs = firstEvent ?? 0;
    const steadyStateDurationMs = Math.max(0, last - t0 - firstEventMs);
    const steadyStateEvents = Math.max(0, count - 1);
    const eventsPerSec =
      steadyStateDurationMs > 0 ? (steadyStateEvents / steadyStateDurationMs) * 1000 : Infinity;

    firstEventSamples.push(firstEventMs);
    eventsPerSecSamples.push(eventsPerSec);
    eventCounts.push(count);
  }

  firstEventSamples.sort((a, b) => a - b);
  const p50First = firstEventSamples[Math.floor(ITERS * 0.5)];
  const p95First = firstEventSamples[Math.floor(ITERS * 0.95)];
  const meanFirst = firstEventSamples.reduce((a, b) => a + b, 0) / ITERS;

  const sortedEps = [...eventsPerSecSamples].sort((a, b) => a - b);
  const medianEps = sortedEps[Math.floor(ITERS * 0.5)];
  const meanEps = eventsPerSecSamples.reduce((a, b) => a + b, 0) / ITERS;

  console.log(
    `chat.completionsStream() — ${NUM_CONTENT_CHUNKS} content chunks/iteration, ${ITERS} iterations`,
  );
  console.log(
    `events per stream (incl. role/finish/done): min=${Math.min(...eventCounts)} max=${Math.max(...eventCounts)}`,
  );
  console.log(
    `time-to-first-event  mean=${meanFirst.toFixed(3)}ms  p50=${p50First.toFixed(3)}ms  p95=${p95First.toFixed(3)}ms`,
  );
  console.log(
    `steady-state throughput  mean=${meanEps.toFixed(1)} events/sec  median=${medianEps.toFixed(1)} events/sec  (${(1_000_000 / medianEps).toFixed(3)} µs/event)`,
  );

  console.log(`\n${p50First < 5 ? "PASS: time-to-first-event p50 < 5ms" : "WARN: time-to-first-event p50 >= 5ms"}`);
  console.log(
    medianEps > 20_000
      ? "PASS: steady-state throughput > 20,000 events/sec"
      : "WARN: steady-state throughput <= 20,000 events/sec",
  );

  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
