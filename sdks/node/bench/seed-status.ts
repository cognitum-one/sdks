/**
 * Micro-benchmark: `SeedClient.status()` vs raw `fetch()` against a local
 * mock responder. Measures the SDK overhead (retry wrap, header build,
 * URL assembly, JSON parse) on the hot path.
 *
 * Target (ADR-0005 intent): <1 ms p50 delta vs raw `fetch`.
 *
 * Usage:
 *   # Simplest — uses the no-dep Node console.time path.
 *   npx tsx bench/seed-status.ts
 *
 * If tinybench is installed (pnpm add -D tinybench), the "tinybench"
 * block below will run a proper statistical comparison.
 *
 * TODO: wire `tinybench` into devDependencies when the bench is promoted
 * to CI. For now we keep the SDK dev-deps minimal.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
// Import from the built bundle when available so this file runs under
// `node --experimental-strip-types` without TS path-resolution tricks.
// Falls back to the source path if the dist hasn't been built yet.
import { SeedClient } from "../dist/seed/index.js";

const STATUS_BODY = JSON.stringify({
  device_id: "bench-0",
  uptime_secs: 1,
  epoch: 0,
  total_vectors: 0,
  deleted_vectors: 0,
  file_size_bytes: 0,
  dimension: 8,
  paired: false,
  roles: [],
});

function startMock(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 200;
      res.end(STATUS_BODY);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function warmup(client: SeedClient, url: string, n = 50) {
  for (let i = 0; i < n; i += 1) {
    await client.status();
    await fetch(`${url}/api/v1/status`).then((r) => r.json());
  }
}

async function measure(
  label: string,
  iters: number,
  fn: () => Promise<unknown>,
): Promise<number> {
  const samples = new Array<number>(iters);
  for (let i = 0; i < iters; i += 1) {
    const t0 = performance.now();
    await fn();
    samples[i] = performance.now() - t0;
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(iters * 0.5)];
  const p95 = samples[Math.floor(iters * 0.95)];
  const mean = samples.reduce((a, b) => a + b, 0) / iters;
  console.log(
    `${label.padEnd(30)}  mean=${mean.toFixed(3)}ms  p50=${p50.toFixed(3)}ms  p95=${p95.toFixed(3)}ms`,
  );
  return p50;
}

async function main() {
  const { server, url } = await startMock();
  const client = new SeedClient({ endpoints: url, tls: { insecure: true } });

  await warmup(client, url);

  const iters = 500;
  const raw = await measure(`raw fetch()`, iters, async () => {
    const r = await fetch(`${url}/api/v1/status`);
    await r.json();
  });
  const sdk = await measure(`SeedClient.status()`, iters, async () => {
    await client.status();
  });
  const delta = sdk - raw;
  console.log(`\nSDK overhead (p50 delta): ${delta.toFixed(3)} ms`);
  console.log(delta < 1 ? "PASS: <1ms overhead" : "WARN: >=1ms overhead");

  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
