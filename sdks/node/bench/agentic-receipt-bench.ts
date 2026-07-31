/**
 * Micro-benchmark: receipt/lineage emission overhead (ADR-0028 §D7-§D9,
 * issue #56 / PR #84) — the canonicalization + digest + parse path that
 * runs on every Meta LLM response carrying a `cognitum_receipt` field
 * (ADR-0024b §D3), and on every locally-constructed `ExecutionReceipt`.
 *
 * Three real, already-shipped functions are exercised:
 *   1. `parseMetaLlmReceipt` — decodes the wire `cognitum_receipt` payload
 *      into a typed `MetaLlmReceipt` on every nonstream/stream response
 *      (`../src/meta-llm/types/receipt.ts`'s doc comment).
 *   2. `buildExecutionReceipt` — constructs an `ExecutionReceipt`, which
 *      internally canonicalizes (JSON, sorted keys) and SHA-256-digests
 *      the signable payload.
 *   3. `verifyExecutionReceipt` — re-canonicalizes and re-digests the
 *      receipt to verify it (shape + digest levels here; the
 *      `cryptographic` HMAC-signature branch is exercised by the SDK's
 *      own unit tests, not this bench, to keep the bench dependency-free
 *      of any signer wiring).
 *
 * The fixture receipt shape matches
 * `sdks/fixtures/receipt-canonicalization/execution-receipt-v1.json` (the
 * cross-SDK canonicalization conformance fixture from PR #84's review
 * fix), so the input size/shape here is representative of a real receipt.
 *
 * Target (engineering estimate, NOT ADR-mandated — no ADR cites a
 * receipt-canonicalization latency number): p50 < 200 µs per operation
 * (looser than the Rust bench's 50µs target — V8 object allocation/GC and
 * `JSON.stringify`'s recursive key-sort walk cost more per call than the
 * Rust equivalent at this scale). No I/O — should be well under the seed
 * client's ADR-0005 <1ms-p50 network-overhead budget either way.
 *
 * Usage:
 *   npx tsx bench/agentic-receipt-bench.ts
 *   node --experimental-strip-types bench/agentic-receipt-bench.ts
 */

import {
  buildExecutionReceipt,
  canonicalJson,
  sha256Hex,
  verifyExecutionReceipt,
  type BuildExecutionReceiptInput,
} from "../dist/agentic/index.js";
import { parseMetaLlmReceipt } from "../dist/meta-llm/index.js";

const ITERS = 20_000;

function measure(label: string, iters: number, fn: () => void): number {
  for (let i = 0; i < 200; i += 1) fn();

  const samples = new Array<number>(iters);
  for (let i = 0; i < iters; i += 1) {
    const t0 = performance.now();
    fn();
    samples[i] = performance.now() - t0;
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(iters * 0.5)];
  const p95 = samples[Math.floor(iters * 0.95)];
  const mean = samples.reduce((a, b) => a + b, 0) / iters;
  console.log(
    `${label.padEnd(55)}  mean=${(mean * 1000).toFixed(3)}µs  p50=${(p50 * 1000).toFixed(3)}µs  p95=${(p95 * 1000).toFixed(3)}µs`,
  );
  return p50;
}

/** Wire `cognitum_receipt` payload — shape/size representative of a real Meta LLM response receipt. */
function wireReceiptPayload(): unknown {
  return {
    request_id: "req_bench_0001",
    resolved_tier: "large",
    resolved_model: "meta-llm-large",
    escalated: false,
    cap_degraded: false,
    routing_reason: "primary_healthy",
    price: { amount: "12.34", currency: "USD" },
    cache_result: "miss",
    cache_savings: { amount: "0.00", currency: "USD" },
    fallback_used: false,
    breaker_counts: { primary: 0, fallback: 0 },
    sub_tenant_id: "tenant-bench-0001",
    safety_summary: { mode: "warn", detector_classes: ["pii", "secrets"], blocked: false },
    usage: { prompt_tokens: 128, completion_tokens: 64, total_tokens: 192, cache_hit_ratio: 0.0 },
    costs: [
      { source: "openrouter", amount: 100.0, currency: "USD", finality: "invoiced" },
      { source: "meta-llm", amount: 12.34, currency: "USD", finality: "estimate" },
    ],
  };
}

/** Matches `sdks/fixtures/receipt-canonicalization/execution-receipt-v1.json`'s `logicalReceipt` shape/size. */
function buildReceiptInput(): BuildExecutionReceiptInput {
  return {
    receiptId: "rcpt_bench_0001",
    product: "meta-llm",
    contractVersion: "1.0.0",
    requestId: "req_bench_abc123",
    operationId: "op_bench_xyz789",
    tenantHash: "th_bench_deadbeef",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:05.250Z",
    usage: { prompt_tokens: 128, completion_tokens: 64, cacheHitRatio: 0.5 },
    costs: [
      { source: "openrouter", amount: 100, currency: "USD", finality: "invoiced" },
      { source: "meta-llm", amount: 12.34, currency: "USD", finality: "estimate" },
    ],
    outcome: "success",
    artifactDigests: [
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ],
    lineageRoot: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    issuer: "cognitum-one/meta-llm",
    keyId: "key-2026-01",
  };
}

function main() {
  console.log(`Receipt/lineage emission overhead — ${ITERS} iterations each\n`);

  // 1. Wire-receipt parse (runs on every Meta LLM response carrying a `cognitum_receipt` field).
  const rawPayload = wireReceiptPayload();
  const p50Parse = measure("parseMetaLlmReceipt", ITERS, () => {
    const receipt = parseMetaLlmReceipt(rawPayload);
    if (!receipt) throw new Error("expected receipt to parse");
  });

  // 2. buildExecutionReceipt — construction + canonicalization + digest (no signer configured).
  const p50Build = measure("buildExecutionReceipt", ITERS, () => {
    const receipt = buildExecutionReceipt(buildReceiptInput());
    if (receipt.verification.level !== "shape") throw new Error("expected shape-level receipt");
  });

  // 3. verifyExecutionReceipt — re-canonicalize + re-digest an already-built receipt.
  const sampleReceipt = buildExecutionReceipt(buildReceiptInput());
  const p50Verify = measure("verifyExecutionReceipt (shape+digest)", ITERS, () => {
    const result = verifyExecutionReceipt(sampleReceipt, { minLevel: "digest" });
    if (!result.subjectDigest) throw new Error("expected subjectDigest to be computed");
  });

  // 4. canonicalJson + sha256Hex alone (the shared primitive both (2) and (3) call internally).
  const p50Primitive = measure("canonicalJson + sha256Hex (primitive)", ITERS, () => {
    const bytes = canonicalJson(sampleReceipt);
    const digest = sha256Hex(bytes);
    if (digest.length !== 64) throw new Error("expected 64-char hex digest");
  });

  const target = 0.2; // ms == 200µs
  const allPass = [p50Parse, p50Build, p50Verify, p50Primitive].every((p50) => p50 < target);
  console.log(
    `\n${allPass ? "PASS" : "WARN"}: all four operations ${allPass ? "clear" : "do NOT all clear"} p50 < 200µs (engineering target, not ADR-mandated).`,
  );
}

main();
