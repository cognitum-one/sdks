/**
 * Micro-benchmark: capability/consent gate overhead across the three
 * fail-closed local checks added this mission (ADR-0019 §D6):
 *
 *   1. `assertConsentForRoutingIntent` — PR #96's consent gating for
 *      `MetaProxyClient` data-plane calls (ADR-0025a §D9): a pure,
 *      synchronous, no-I/O function.
 *   2. `HarnessaaSClient.solve()`'s local capability gate (PR #109/#111,
 *      issue #74) — an async method, but the benchmarked path (an
 *      unsupported `vertical`) returns before any credential acquisition
 *      or HTTP call is made (`assertSolveCapability` throws first).
 *   3. `MetaHarnessClient`'s fail-closed §D2 stubs (ADR-0026a) — every
 *      operational method (`capabilities()` here) throws
 *      `UnsupportedCapabilityError` before any process/network/filesystem
 *      access, since no bridge protocol exists upstream yet.
 *
 * These are all meant to be fast local pre-I/O gates, not bottlenecks —
 * this bench exists to confirm that empirically (microseconds, not
 * milliseconds) rather than assume it.
 *
 * Target (engineering estimate, NOT ADR-mandated — ADR-0019 §D6 requires
 * these checks happen locally before I/O, but does not cite a latency
 * number): p50 < 200 µs per gate check (a looser target than the Rust
 * SDK's equivalent bench, since V8 async/Promise overhead and object
 * allocation dominate at this scale rather than the check logic itself).
 *
 * Usage:
 *   npx tsx bench/agentic-capability-bench.ts
 *   node --experimental-strip-types bench/agentic-capability-bench.ts
 */

import { assertConsentForRoutingIntent, type RoutingIntent } from "../dist/meta-proxy/index.js";
import { HarnessaaSClient, type HarnessaaSSolveRequest } from "../dist/harnessaas/index.js";
import { MetaHarnessClient } from "../dist/metaharness/index.js";
import type { ConsentGrant } from "../dist/agentic/index.js";

const ITERS = 20_000;

async function measure(label: string, iters: number, fn: () => Promise<unknown> | unknown): Promise<number> {
  for (let i = 0; i < 200; i += 1) await fn();

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
    `${label.padEnd(62)}  mean=${(mean * 1000).toFixed(3)}µs  p50=${(p50 * 1000).toFixed(3)}µs  p95=${(p95 * 1000).toFixed(3)}µs`,
  );
  return p50;
}

function expiredGrant(): ConsentGrant {
  return {
    kind: "cloud_fallback",
    product: "meta-proxy",
    origin: "http://127.0.0.1:11434",
    subject: "bench-subject",
    scope: "chat.completions",
    issuedAt: "2020-01-01T00:00:00Z",
    expiresAt: "2020-01-02T00:00:00Z",
  };
}

function validGrant(): ConsentGrant {
  return {
    kind: "cloud_fallback",
    product: "meta-proxy",
    origin: "http://127.0.0.1:11434",
    subject: "bench-subject",
    scope: "chat.completions",
    issuedAt: "2020-01-01T00:00:00Z",
    expiresAt: "2099-01-01T00:00:00Z",
  };
}

function solveRequest(): HarnessaaSSolveRequest {
  return {
    repo: "https://github.com/acme/widget.git",
    testCommand: "pytest -k test_widget",
    issue: "Widget renders twice",
  };
}

async function main() {
  console.log(`Capability/consent gate overhead — ${ITERS} iterations each\n`);

  // ------------------------------------------------------------------
  // 1. MetaProxyClient consent gate (pure, synchronous, no I/O).
  // ------------------------------------------------------------------
  const origin = "http://127.0.0.1:11434";
  const cloudIntent: RoutingIntent = {
    requiredPlane: "cognitum_cloud",
    allowedPlanes: [],
    workloadPolicy: "standard",
    consentGrants: [],
    trainingShare: false,
    failIfUnavailable: false,
  };
  const localIntent: RoutingIntent = {
    allowedPlanes: ["local"],
    workloadPolicy: "standard",
    consentGrants: [],
    trainingShare: false,
    failIfUnavailable: false,
  };

  const noGrants: ConsentGrant[] = [];
  const expired = [expiredGrant()];
  const valid = [validGrant()];

  await measure("assertConsentForRoutingIntent (no-op: local plane)", ITERS, () => {
    try {
      assertConsentForRoutingIntent(localIntent, noGrants, origin, "chat.completions");
    } catch {
      /* expected control-flow branch coverage only */
    }
  });

  await measure("assertConsentForRoutingIntent (reject: no matching grant)", ITERS, () => {
    try {
      assertConsentForRoutingIntent(cloudIntent, expired, origin, "chat.completions");
    } catch {
      /* expected: ConsentRequiredError */
    }
  });

  await measure("assertConsentForRoutingIntent (accept: valid grant present)", ITERS, () => {
    assertConsentForRoutingIntent(cloudIntent, valid, origin, "chat.completions");
  });

  // ------------------------------------------------------------------
  // 2. HarnessaaSClient.solve() local capability gate. Base URL is never
  // actually dialed: the unsupported-vertical rejection happens in
  // `assertSolveCapability` before any credential acquisition or HTTP
  // call, so this measures pure gate overhead, not network I/O.
  // ------------------------------------------------------------------
  const harnessaasClient = new HarnessaaSClient({ baseUrl: "https://harnessaas.bench.invalid" });
  const unsupportedRequest: HarnessaaSSolveRequest = {
    ...solveRequest(),
    vertical: "security-remediation",
  };

  await measure("HarnessaaSClient.solve (reject: unsupported vertical, pre-I/O)", ITERS, async () => {
    try {
      await harnessaasClient.solve(unsupportedRequest);
    } catch {
      /* expected: UnsupportedCapabilityError */
    }
  });

  // ------------------------------------------------------------------
  // 3. MetaHarnessClient fail-closed §D2 stub. No bridge process is ever
  // spawned; the whole call is a synchronous check + typed error return
  // wrapped in an async fn.
  // ------------------------------------------------------------------
  const metaharnessClient = new MetaHarnessClient({});

  await measure("MetaHarnessClient.capabilities (fail-closed stub, pre-I/O)", ITERS, async () => {
    try {
      await metaharnessClient.capabilities();
    } catch {
      /* expected: UnsupportedCapabilityError */
    }
  });

  console.log("\nAll three gates are expected to clear p50 < 200µs (engineering target, not ADR-mandated).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
