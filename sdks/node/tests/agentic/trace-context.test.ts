/**
 * Tests for W3C Trace Context parse/generate/join logic and stable
 * span-name builders (ADR-0028 §D2).
 */

import { describe, it, expect } from "vitest";
import {
  parseTraceParent,
  generateTraceParent,
  parseTraceState,
  formatTraceState,
  joinOrGenerateTraceContext,
  applyTraceContext,
  metaLlmSpanName,
  metaProxySpanName,
  metaharnessSpanName,
  harnessaasSpanName,
  DEFAULT_TRACE_FLAGS,
} from "../../src/agentic/trace-context.js";

const VALID_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("parseTraceParent", () => {
  it("parses the spec example traceparent", () => {
    const ctx = parseTraceParent(VALID_TRACEPARENT);
    expect(ctx).not.toBeNull();
    expect(ctx?.traceParent).toBe(VALID_TRACEPARENT);
    expect(ctx?.traceState).toBeUndefined();
  });

  it("rejects wrong version", () => {
    expect(parseTraceParent("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeNull();
    expect(parseTraceParent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeNull();
  });

  it("rejects wrong trace-id length", () => {
    expect(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e47-00f067aa0ba902b7-01")).toBeNull();
    expect(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e473600-00f067aa0ba902b7-01")).toBeNull();
  });

  it("rejects all-zero trace-id", () => {
    expect(parseTraceParent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeNull();
  });

  it("rejects all-zero parent-id", () => {
    expect(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01")).toBeNull();
  });

  it("rejects wrong parent-id length", () => {
    expect(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902-01")).toBeNull();
    expect(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7ff-01")).toBeNull();
  });

  it("rejects wrong separator count", () => {
    expect(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7")).toBeNull();
    expect(
      parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra"),
    ).toBeNull();
    expect(parseTraceParent("not-a-traceparent-at-all-really")).toBeNull();
  });

  it("rejects non-hex characters", () => {
    expect(parseTraceParent("00-ZZf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeNull();
    expect(parseTraceParent("00-4Bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeNull();
    expect(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-ZZ")).toBeNull();
  });

  it("never throws on empty or garbage input", () => {
    expect(() => parseTraceParent("")).not.toThrow();
    expect(parseTraceParent("")).toBeNull();
    expect(parseTraceParent("-")).toBeNull();
    expect(parseTraceParent("----")).toBeNull();
  });

  it("rejects wrong-length trace-flags", () => {
    expect(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-0")).toBeNull();
    expect(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-011")).toBeNull();
  });
});

describe("generateTraceParent", () => {
  it("produces a valid, reparseable traceparent", () => {
    const ctx = generateTraceParent();
    expect(ctx.traceParent).toBeDefined();
    const reparsed = parseTraceParent(ctx.traceParent as string);
    expect(reparsed).not.toBeNull();
    expect(reparsed?.traceParent).toBe(ctx.traceParent);
    expect(ctx.traceParent?.endsWith(`-${DEFAULT_TRACE_FLAGS}`)).toBe(true);
  });

  it("produces distinct values across calls", () => {
    const a = generateTraceParent().traceParent;
    const b = generateTraceParent().traceParent;
    expect(a).not.toBe(b);
  });
});

describe("parseTraceState / formatTraceState", () => {
  it("round-trips", () => {
    const members = parseTraceState("congo=t61rcWkgMzE,rojo=00f067aa0ba902b7");
    expect(members).not.toBeNull();
    expect(members).toHaveLength(2);
    expect(members?.[0]).toEqual({ key: "congo", value: "t61rcWkgMzE" });
    const formatted = formatTraceState(members as { key: string; value: string }[]);
    expect(formatted).toBe("congo=t61rcWkgMzE,rojo=00f067aa0ba902b7");
    expect(parseTraceState(formatted)).toEqual(members);
  });

  it("accepts a vendor-tenant key", () => {
    const members = parseTraceState("tenant-1@vendor=value1");
    expect(members?.[0].key).toBe("tenant-1@vendor");
  });

  it("rejects an empty header", () => {
    expect(parseTraceState("")).toBeNull();
    expect(parseTraceState("   ")).toBeNull();
  });

  it("rejects too many members", () => {
    const header = Array.from({ length: 33 }, (_, i) => `k${i}=v`).join(",");
    expect(parseTraceState(header)).toBeNull();
  });

  it("accepts exactly 32 members", () => {
    const header = Array.from({ length: 32 }, (_, i) => `k${i}=v`).join(",");
    expect(parseTraceState(header)).not.toBeNull();
  });

  it("rejects malformed keys and values", () => {
    expect(parseTraceState("Congo=value")).toBeNull(); // uppercase key
    expect(parseTraceState("congo=")).toBeNull(); // empty value
    expect(parseTraceState("=value")).toBeNull(); // empty key
    expect(parseTraceState("congo=va,lue")).toBeNull(); // comma splits into malformed members
    expect(parseTraceState("congo=va=lue")).toBeNull(); // '=' inside value
    expect(parseTraceState("con go=value")).toBeNull(); // space in key
    expect(parseTraceState("congo= value")).toBeNull(); // leading space in value
    expect(parseTraceState("a@b@c=value")).toBeNull(); // more than one '@'
    // W3C tracestate OWS is space/HTAB only (RFC 7230 OWS) -- a form-feed
    // is not OWS and must not be silently trimmed away, so it fails the
    // key's charset check. Matches Rust's `trim_matches(' ' | '\t')`.
    expect(parseTraceState("\x0ccongo=value")).toBeNull();
  });
});

describe("joinOrGenerateTraceContext", () => {
  it("reuses the trace-id but generates a new parent-id when the incoming header is valid", () => {
    const joined = joinOrGenerateTraceContext(VALID_TRACEPARENT);
    expect(joined.traceParent?.startsWith("00-4bf92f3577b34da6a3ce929d0e0e4736-")).toBe(true);
    expect(joined.traceParent).not.toContain("00f067aa0ba902b7");
  });

  it("falls back to generation without throwing when the incoming header is invalid", () => {
    expect(() => joinOrGenerateTraceContext("garbage-not-a-traceparent")).not.toThrow();
    const joined = joinOrGenerateTraceContext("garbage-not-a-traceparent");
    expect(parseTraceParent(joined.traceParent as string)).not.toBeNull();
  });

  it("falls back to generation on a variety of malformed incoming headers, never throwing", () => {
    const badInputs = [
      "garbage-not-a-traceparent",
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
      "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "",
    ];
    for (const bad of badInputs) {
      expect(() => joinOrGenerateTraceContext(bad)).not.toThrow();
      const joined = joinOrGenerateTraceContext(bad);
      expect(parseTraceParent(joined.traceParent as string)).not.toBeNull();
    }
  });

  it("generates when no incoming header is supplied", () => {
    const joined = joinOrGenerateTraceContext();
    expect(joined.traceParent).toBeDefined();
  });

  it("carries a valid incoming tracestate and drops an invalid one", () => {
    const joined = joinOrGenerateTraceContext(VALID_TRACEPARENT, "congo=t61rcWkgMzE");
    expect(joined.traceState).toBe("congo=t61rcWkgMzE");

    const joinedInvalid = joinOrGenerateTraceContext(VALID_TRACEPARENT, "Not Valid");
    expect(joinedInvalid.traceState).toBeUndefined();
  });

  it("attaches a fresh child traceparent to outgoing headers", () => {
    const headers: Record<string, string> = {};
    applyTraceContext(headers, { traceparent: VALID_TRACEPARENT, tracestate: "congo=t61rcWkgMzE" });
    expect(headers.traceparent).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-00$/);
    expect(headers.tracestate).toBe("congo=t61rcWkgMzE");
  });
});

describe("span name builders", () => {
  it("match the ADR-0028 §D2 format exactly", () => {
    expect(metaLlmSpanName("chat.completions.create")).toBe("cognitum.meta_llm.chat.completions.create");
    expect(metaProxySpanName("route")).toBe("cognitum.meta_proxy.route");
    expect(metaharnessSpanName("score")).toBe("cognitum.metaharness.score");
    expect(harnessaasSpanName("solve")).toBe("cognitum.harnessaas.solve");
  });
});
