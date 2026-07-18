import { describe, it, expect } from "vitest";
import { createHash, createHmac } from "node:crypto";
import {
  buildExecutionReceipt,
  verifyExecutionReceipt,
  verifyLineageChain,
  canonicalJson,
} from "../src/agentic/receipt-verification.js";
import type {
  ExecutionReceipt,
  LineageReference,
} from "../src/agentic/receipts.js";

const KEY = new TextEncoder().encode("test-signing-key");
const resolveKey = (issuer: string, keyId: string) =>
  issuer === "cognitum-one" && keyId === "key-1" ? KEY : undefined;

function makeReceipt(overrides: Partial<Parameters<typeof buildExecutionReceipt>[0]> = {}) {
  return buildExecutionReceipt({
    receiptId: "rcpt_1",
    product: "harnessaas",
    contractVersion: "1.0",
    requestId: "req_1",
    operationId: "op_1",
    startedAt: "2026-07-18T00:00:00.000Z",
    completedAt: "2026-07-18T00:00:05.000Z",
    outcome: "succeeded",
    costs: [{ source: "provider", amount: 0.01, currency: "USD", finality: "estimate" }],
    issuer: "cognitum-one",
    keyId: "key-1",
    sign: (bytes) =>
      // Mirrors what a real out-of-band signer service would do.
      createHmac("sha256", Buffer.from(KEY)).update(bytes, "utf8").digest("hex"),
    ...overrides,
  });
}

describe("buildExecutionReceipt", () => {
  it("produces a shape-valid receipt with the fields filled in", () => {
    const receipt = makeReceipt();
    expect(receipt.schema).toBe("cognitum.execution-receipt.v1");
    expect(receipt.subject.requestId).toBe("req_1");
    expect(receipt.verification.level).toBe("shape");
    expect(receipt.verification.valid).toBe(true);
    expect(receipt.canonicalization).toBe("cognitum-canonical-json-v1");
  });

  it("flags a structurally incomplete receipt at build time", () => {
    const receipt = makeReceipt({ outcome: "" });
    expect(receipt.verification.level).toBe("none");
    expect(receipt.verification.valid).toBe(false);
    expect(receipt.verification.failure).toMatch(/outcome/);
  });
});

describe("verifyExecutionReceipt", () => {
  it("verifies a valid, signed receipt up to the cryptographic level", () => {
    const receipt = makeReceipt();
    const result = verifyExecutionReceipt(receipt, { minLevel: "cryptographic", resolveKey });
    expect(result.valid).toBe(true);
    expect(result.level).toBe("cryptographic");
    expect(result.algorithm).toBe("hmac-sha256");
  });

  it("rejects a receipt whose signature was tampered with", () => {
    const receipt = makeReceipt();
    const tampered: ExecutionReceipt = { ...receipt, outcome: "failed" };
    const result = verifyExecutionReceipt(tampered, { minLevel: "cryptographic", resolveKey });
    expect(result.valid).toBe(false);
    expect(result.level).toBe("none");
    expect(result.failure).toMatch(/signature/);
  });

  it("rejects a receipt whose costs were tampered with post-signing", () => {
    const receipt = makeReceipt();
    const tampered: ExecutionReceipt = {
      ...receipt,
      costs: [{ source: "provider", amount: 999, currency: "USD", finality: "estimate" }],
    };
    const result = verifyExecutionReceipt(tampered, { minLevel: "digest", resolveKey });
    expect(result.valid).toBe(false);
  });

  it("a lowest-level (shape-only) receipt correctly skips cryptographic checks it never claimed", () => {
    const receipt = buildExecutionReceipt({
      receiptId: "rcpt_2",
      product: "meta-llm",
      contractVersion: "1.0",
      requestId: "req_2",
      startedAt: "2026-07-18T00:00:00.000Z",
      outcome: "succeeded",
      // no issuer/keyId/sign -- this receipt never claims a signature
    });
    expect(receipt.signature).toBeUndefined();

    const result = verifyExecutionReceipt(receipt, { minLevel: "shape" });
    expect(result.valid).toBe(true);
    expect(result.level).toBe("shape");

    // Asking for more than the receipt claims fails closed, without ever
    // attempting a (meaningless) signature check.
    const strict = verifyExecutionReceipt(receipt, { minLevel: "cryptographic" });
    expect(strict.valid).toBe(false);
    expect(strict.warnings).toContain("receipt carries no signature/issuer/keyId claim");
  });

  it("achieves digest level when caller supplies a matching expected digest", () => {
    const receipt = buildExecutionReceipt({
      receiptId: "rcpt_3",
      product: "meta-proxy",
      contractVersion: "1.0",
      requestId: "req_3",
      startedAt: "2026-07-18T00:00:00.000Z",
      outcome: "succeeded",
    });
    const { signature: _s, verification: _v, ...signable } = receipt;
    const digest = createHash("sha256").update(canonicalJson(signable), "utf8").digest("hex");

    const result = verifyExecutionReceipt(receipt, { minLevel: "digest", expectedDigest: digest });
    expect(result.valid).toBe(true);
    expect(result.level).toBe("digest");
  });
});

function makeChain(): LineageReference[] {
  const base = (i: number, prevRoot?: string): LineageReference => ({
    schema: "cognitum.lineage-reference.v1",
    subject: { requestId: "req_1" },
    leaf: `leaf-${i}`,
    root: `root-${i}`,
    sequence: i,
    previousCheckpoint: prevRoot,
    checkpointTime: "2026-07-18T00:00:00.000Z",
    verification: { level: "none", valid: false, checkedAt: "2026-07-18T00:00:00.000Z" },
  });
  return [base(0), base(1, "root-0"), base(2, "root-1")];
}

describe("verifyLineageChain", () => {
  it("accepts a well-formed chain", () => {
    const result = verifyLineageChain(makeChain(), { minLevel: "digest" });
    expect(result.valid).toBe(true);
    expect(result.results).toHaveLength(3);
  });

  it("rejects a chain with a broken link (wrong previousCheckpoint)", () => {
    const chain = makeChain();
    chain[2] = { ...chain[2], previousCheckpoint: "root-999" };
    const result = verifyLineageChain(chain, { minLevel: "digest" });
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(2);
    expect(result.failure).toMatch(/previousCheckpoint/);
  });

  it("rejects a chain containing a cycle", () => {
    const chain = makeChain();
    // Force entry 2's root to repeat entry 0's root.
    chain[2] = { ...chain[2], root: "root-0" };
    const result = verifyLineageChain(chain, { minLevel: "shape" });
    expect(result.valid).toBe(false);
    expect(result.failure).toMatch(/cycle/);
  });

  it("rejects a chain whose sequence does not strictly increase", () => {
    const chain = makeChain();
    chain[2] = { ...chain[2], sequence: 1 };
    const result = verifyLineageChain(chain, { minLevel: "shape" });
    expect(result.valid).toBe(false);
    expect(result.failure).toMatch(/sequence/);
  });

  it("a single-entry (genesis-only) chain achieves only shape, not digest", () => {
    const chain = [makeChain()[0]];
    const shapeResult = verifyLineageChain(chain, { minLevel: "shape" });
    expect(shapeResult.valid).toBe(true);
    expect(shapeResult.level).toBe("shape");

    const strict = verifyLineageChain(chain, { minLevel: "digest" });
    expect(strict.valid).toBe(false);
  });
});
