/**
 * SentinelSecretRedactor conformance — closes cognitum-one/sdks#54 (Node).
 *
 * Pins the exact mechanism specified by ADR-0028 §D13: fixed-format
 * matchers, an entropy fallback, a D12 key-name check, bounded-depth-8 DFS
 * traversal, and cycle detection.
 */

import { describe, it, expect } from "vitest";
import { SentinelSecretRedactor } from "../../src/agentic/sentinel.js";

const redactor = new SentinelSecretRedactor();

// A syntactically bearer-token-shaped string. Not a real credential.
const BEARER_TOKEN = "Bearer AbCdEfGhIjKlMnOpQrStUvWxYz0123456789.-_ABCDEF";

// High-entropy but not a recognized fixed format (no dots, no known prefix).
const HIGH_ENTROPY_UNRECOGNIZED = "Xk92LpQz8vT3mNc7Rw4YbHj1FdEa6Su0";

// Realistic 32/64-char hex-encoded secrets (e.g. API keys, session tokens,
// hashes) -- a very common real-world secret shape. Their per-string Shannon
// entropy is 3.46 / 3.68 bits/char: well above the hex-charset-scoped 3.0
// threshold, but nowhere near the unreachable 4.0 theoretical max for a
// 16-symbol alphabet that the old single global threshold required.
const HEX_SECRET_32 = "eee65f53e9421ce50211670eae679f02";
const HEX_SECRET_64 =
  "a4c123b1612dd272d1371c17149d439536b3216fdaeeb975729fae923d5a4fd1";

// Long but genuinely low-entropy prose.
const NORMAL_SENTENCE =
  "The quick brown fox jumps over the lazy dog in the summer evening.";

/** Build `depth` levels of nesting (a1 -> a2 -> ... -> a<depth>: leaf). */
function buildNested(depth: number, leaf: unknown): unknown {
  let node: unknown = leaf;
  for (let i = depth; i >= 1; i--) {
    node = { [`a${i}`]: node };
  }
  return node;
}

describe("SentinelSecretRedactor", () => {
  it("(a) redacts a bearer-token-shaped string in a flat object", () => {
    const input = { authToken: BEARER_TOKEN, note: "hello" };
    const out = redactor.redact(input) as typeof input;
    expect(out.authToken).toBe("[redacted:secret-pattern]");
    expect(out.note).toBe("hello");
  });

  it("(b) redacts a secret buried in a nested object (depth < 8) via recursion", () => {
    // 3 levels deep: well within the depth-8 bound. Field name deliberately
    // neutral so this exercises the *value-shape* matcher, not the D12
    // key-name check (covered separately below).
    const input = buildNested(3, { value: BEARER_TOKEN, safe: "ok" }) as {
      a1: { a2: { a3: { value: string; safe: string } } };
    };
    const out = redactor.redact(input);
    expect(out.a1.a2.a3.value).toBe("[redacted:secret-pattern]");
    expect(out.a1.a2.a3.safe).toBe("ok");
  });

  it("(c) replaces a value at exactly depth 9 with [max-depth-exceeded] instead of scanning it", () => {
    // 9 levels of nesting (a1..a9) puts the leaf itself at depth 9.
    const input = buildNested(9, BEARER_TOKEN) as {
      a1: { a2: { a3: { a4: { a5: { a6: { a7: { a8: { a9: string } } } } } } } };
    };
    const out = redactor.redact(input);
    expect(out.a1.a2.a3.a4.a5.a6.a7.a8.a9).toBe("[max-depth-exceeded]");
  });

  it("(d) breaks a cyclic/self-referential structure without infinite looping", () => {
    type Cyclic = { name: string; self?: Cyclic };
    const obj: Cyclic = { name: "root" };
    obj.self = obj;

    const out = redactor.redact(obj);

    expect(out.name).toBe("root");
    expect(out.self).toBe("[cyclic-reference]");
  });

  it("(e) redacts a high-entropy string that is not a recognized secret format", () => {
    const input = { note: HIGH_ENTROPY_UNRECOGNIZED };
    expect(redactor.classify("note", HIGH_ENTROPY_UNRECOGNIZED)).toBe("secret");
    const out = redactor.redact(input) as typeof input;
    expect(out.note).toBe("[redacted:high-entropy]");
  });

  it("(f) does not falsely redact a normal, low-entropy string", () => {
    const input = { description: NORMAL_SENTENCE };
    expect(redactor.classify("description", NORMAL_SENTENCE)).toBe("public");
    const out = redactor.redact(input) as typeof input;
    expect(out.description).toBe(NORMAL_SENTENCE);
  });

  it("(g) redacts a 32-char hex-encoded secret via the entropy fallback (regression: hex never reaches the 4.0 global max)", () => {
    // This is the exact case that was silently failing before: a hex-only
    // token's entropy (3.46 bits/char here) can never reach the 4.0 bits/char
    // theoretical max for a 16-symbol alphabet, so a single global 4.0
    // threshold never fires for real hex secrets. The charset-scoped 3.0
    // threshold catches it.
    expect(redactor.classify("note", HEX_SECRET_32)).toBe("secret");
    const out = redactor.redact({ note: HEX_SECRET_32 }) as { note: string };
    expect(out.note).toBe("[redacted:high-entropy]");
  });

  it("(h) redacts a 64-char hex-encoded secret via the entropy fallback", () => {
    expect(redactor.classify("note", HEX_SECRET_64)).toBe("secret");
    const out = redactor.redact({ note: HEX_SECRET_64 }) as { note: string };
    expect(out.note).toBe("[redacted:high-entropy]");
  });

  it("classify() consults the D12 key-name list independent of value shape", () => {
    expect(redactor.classify("apiKey", "not-secret-shaped-value")).toBe("secret");
    expect(redactor.classify("prompt", "hello there")).toBe("sensitive");
    expect(redactor.classify("repositoryUrl", "https://example.test/repo")).toBe(
      "sensitive",
    );
    expect(redactor.classify("count", "42")).toBe("public");
  });
});
