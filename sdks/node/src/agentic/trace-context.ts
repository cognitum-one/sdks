/**
 * W3C Trace Context parse / generate / join logic and stable span-name
 * builders (ADR-0028 §D2).
 *
 * This module ADDS real logic on top of the {@link TraceContext} carrier
 * type frozen in `./telemetry.ts` during the §D1/§D3 pass (PR #115) -- it
 * does not redefine that type. Per §D2: "Remote HTTP clients propagate W3C
 * `traceparent` and `tracestate` when enabled and when allowed by the
 * product contract... Trace context is generated or joined by the SDK but
 * never used as an authorization, tenant, idempotency, or evidence
 * identity. Untrusted server or subprocess trace values are validated
 * before joining."
 *
 * Nothing in this module performs network I/O or wires into a product
 * client's HTTP request logic (meta-llm/meta-proxy/metaharness/harnessaas)
 * -- that is explicitly out of scope for this pass, mirroring how
 * `sse/parser.ts` shipped as a protocol-agnostic core before any product
 * wired it in.
 *
 * ## W3C Trace Context spec simplifications made in this pass
 *
 * - **Version**: only `traceparent` version `"00"` is accepted. The spec's
 *   own forward-compatibility rule (Trace Context, "Versioning of
 *   traceparent") allows a higher version to append trailing fields after
 *   `trace-flags`; this SDK has no use for any such field, so rather than
 *   parse-and-ignore unknown trailing data, any non-`"00"` version (or a
 *   `traceparent` that does not split into exactly four `-`-separated
 *   fields) is treated as invalid input. Per §D2's "untrusted values must
 *   be validated before joining," {@link joinOrGenerateTraceContext} simply
 *   falls back to generating a fresh trace context in that case rather than
 *   guessing at a newer wire shape.
 * - **`tracestate`**: a "reasonably strict" validator, not the full spec.
 *   Enforced: non-empty, at most 32 members, each `key=value` pair with a
 *   key restricted to lowercase alphanumerics plus `-`/`*`/`_`/`/` (with at
 *   most one `@` tenant/vendor separator, each side non-empty) and a value
 *   restricted to printable ASCII (0x20-0x7E) excluding `,`/`=` and
 *   leading/trailing spaces. Not enforced: the spec's separate tenant-id
 *   (<=241 chars) / vendor-id (<=13 chars) length caps around `@` -- this
 *   pass uses one shared 256-char cap on each side instead.
 * - **Random source**: `node:crypto`'s `randomBytes` (already used
 *   elsewhere in this module tree, e.g. `oauth-token-provider.ts`) is a
 *   cryptographically secure OS-backed source, so generation here uses it
 *   directly -- no new dependency, and no need to fall back to a
 *   non-cryptographic PRNG (unlike the Rust SDK, where the equivalent
 *   secure-random dependency, `uuid`, is feature-gated behind product
 *   features this base module cannot depend on).
 */

import { randomBytes } from "node:crypto";

import type { TraceContext } from "./telemetry.js";

/** The only `traceparent` version this implementation accepts. See the module doc comment's "Version" simplification. */
export const TRACE_VERSION = "00";

/** Default `trace-flags` value used when this SDK generates a new trace-parent: bit 0 ("sampled") set. */
export const DEFAULT_TRACE_FLAGS = "01";

/** Max `tracestate` list members this parser accepts (matches the W3C spec's own cap). */
export const MAX_TRACESTATE_MEMBERS = 32;

interface TraceParentComponents {
  traceId: string;
  parentId: string;
  traceFlags: string;
}

function isLowercaseHex(s: string, expectedLen: number): boolean {
  return s.length === expectedLen && /^[0-9a-f]+$/.test(s);
}

function isAllZero(s: string): boolean {
  return /^0+$/.test(s);
}

/** Splits and validates a raw `traceparent` header into its components. Returns `null` on ANY malformed input -- never throws. */
function parseTraceParentComponents(header: string): TraceParentComponents | null {
  const parts = header.split("-");
  if (parts.length !== 4) {
    return null; // wrong separator count
  }
  const [version, traceId, parentId, traceFlags] = parts;
  if (version !== TRACE_VERSION) {
    return null;
  }
  if (!isLowercaseHex(traceId, 32) || isAllZero(traceId)) {
    return null;
  }
  if (!isLowercaseHex(parentId, 16) || isAllZero(parentId)) {
    return null;
  }
  if (!isLowercaseHex(traceFlags, 2)) {
    return null;
  }
  return { traceId, parentId, traceFlags };
}

/**
 * Parses and validates a raw `traceparent` header value (W3C Trace Context:
 * `{version}-{trace-id}-{parent-id}-{trace-flags}`, e.g.
 * `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`). Returns `null`
 * on ANY malformed input (wrong version, wrong hex-char-count, all-zero
 * trace-id or parent-id, wrong separator count, non-hex characters) --
 * never throws, matching §D2's "untrusted server or subprocess trace values
 * are validated before joining."
 */
export function parseTraceParent(header: string): TraceContext | null {
  if (!parseTraceParentComponents(header)) {
    return null;
  }
  return { traceParent: header };
}

function randomHexNonzero(byteLen: number): string {
  // Astronomically unlikely to loop more than once; guards against the
  // all-zero case the spec forbids.
  for (;;) {
    const bytes = randomBytes(byteLen);
    if (bytes.some((b) => b !== 0)) {
      return bytes.toString("hex");
    }
  }
}

/**
 * Generates a fresh, valid `traceparent`: a random 32-hex-char trace-id and
 * 16-hex-char parent-id (both guaranteed nonzero), `trace-flags = "01"`
 * (sampled).
 */
export function generateTraceParent(): TraceContext {
  const traceId = randomHexNonzero(16); // 16 bytes -> 32 hex chars
  const parentId = randomHexNonzero(8); // 8 bytes -> 16 hex chars
  return {
    traceParent: `${TRACE_VERSION}-${traceId}-${parentId}-${DEFAULT_TRACE_FLAGS}`,
  };
}

/** One validated `tracestate` list member. */
export interface TraceStateMember {
  key: string;
  value: string;
}

function isValidTraceStateKeyCharset(s: string): boolean {
  return s.length > 0 && s.length <= 256 && /^[a-z0-9][a-z0-9\-*_/]*$/.test(s);
}

function isValidTraceStateKey(key: string): boolean {
  const atIndex = key.indexOf("@");
  if (atIndex === -1) {
    return isValidTraceStateKeyCharset(key);
  }
  if (key.indexOf("@", atIndex + 1) !== -1) {
    return false; // more than one '@'
  }
  const tenant = key.slice(0, atIndex);
  const vendor = key.slice(atIndex + 1);
  return (
    tenant.length > 0 &&
    vendor.length > 0 &&
    isValidTraceStateKeyCharset(tenant) &&
    isValidTraceStateKeyCharset(vendor)
  );
}

function isValidTraceStateValue(value: string): boolean {
  if (value.length === 0 || value.length > 256) {
    return false;
  }
  if (value.startsWith(" ") || value.endsWith(" ")) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const ch = value[i];
    if (code < 0x20 || code > 0x7e || ch === "," || ch === "=") {
      return false;
    }
  }
  return true;
}

/**
 * Parses a raw `tracestate` header value into an ordered list of validated
 * `key=value` members (comma-separated, up to {@link MAX_TRACESTATE_MEMBERS}).
 * Returns `null` on ANY malformed input (empty, too many members, malformed
 * key/value characters) -- never throws. See the module doc comment for
 * exactly which spec details this validator simplifies.
 */
export function parseTraceState(header: string): TraceStateMember[] | null {
  if (header.trim().length === 0) {
    return null;
  }
  const members: TraceStateMember[] = [];
  for (const rawMember of header.split(",")) {
    // W3C tracestate OWS is space/HTAB only (RFC 7230 OWS), not arbitrary
    // Unicode whitespace -- match Rust's `trim_matches(' ' | '\t')` exactly
    // rather than `String.prototype.trim()`'s broader definition.
    let start = 0;
    let end = rawMember.length;
    while (start < end && (rawMember[start] === " " || rawMember[start] === "\t")) start++;
    while (end > start && (rawMember[end - 1] === " " || rawMember[end - 1] === "\t")) end--;
    const member = rawMember.slice(start, end);
    if (member.length === 0) {
      return null;
    }
    const eqIndex = member.indexOf("=");
    if (eqIndex === -1) {
      return null;
    }
    const key = member.slice(0, eqIndex);
    const value = member.slice(eqIndex + 1);
    if (!isValidTraceStateKey(key) || !isValidTraceStateValue(value)) {
      return null;
    }
    members.push({ key, value });
  }
  if (members.length === 0 || members.length > MAX_TRACESTATE_MEMBERS) {
    return null;
  }
  return members;
}

/** Formats a list of `tracestate` members back into the wire string. */
export function formatTraceState(members: TraceStateMember[]): string {
  return members.map((m) => `${m.key}=${m.value}`).join(",");
}

/**
 * Joins an incoming, untrusted `traceparent`/`tracestate` pair if valid, or
 * generates a fresh trace context otherwise. Per §D2: a receiving service
 * keeps the incoming trace-id but generates its own new parent-id/span-id
 * (this SDK is a new span in the same trace); `trace-flags` is reset to
 * {@link DEFAULT_TRACE_FLAGS} since this pass does not interpret or
 * propagate the incoming sampling bit. An invalid incoming `traceparent`
 * NEVER throws and NEVER gets joined -- it falls back to generation,
 * matching "untrusted server or subprocess trace values are validated
 * before joining." An invalid incoming `tracestate` is silently dropped
 * (treated as absent) rather than invalidating the whole join.
 */
export function joinOrGenerateTraceContext(
  incomingTraceparentHeader?: string,
  incomingTracestateHeader?: string,
): TraceContext {
  const parsedTraceState = incomingTracestateHeader ? parseTraceState(incomingTracestateHeader) : null;
  const traceState = parsedTraceState ? formatTraceState(parsedTraceState) : undefined;

  const components = incomingTraceparentHeader
    ? parseTraceParentComponents(incomingTraceparentHeader)
    : null;

  const traceParent = components
    ? `${TRACE_VERSION}-${components.traceId}-${randomHexNonzero(8)}-${DEFAULT_TRACE_FLAGS}`
    : generateTraceParent().traceParent;

  return traceState !== undefined ? { traceParent, traceState } : { traceParent };
}

// ---------------------------------------------------------------------
// §D2: Stable span names, `cognitum.<product>.<operation>` format.
// ---------------------------------------------------------------------

/** Builds the stable span name `cognitum.meta_llm.<operation>`. */
export function metaLlmSpanName(operation: string): string {
  return `cognitum.meta_llm.${operation}`;
}

/** Builds the stable span name `cognitum.meta_proxy.<operation>`. */
export function metaProxySpanName(operation: string): string {
  return `cognitum.meta_proxy.${operation}`;
}

/** Builds the stable span name `cognitum.metaharness.<operation>`. */
export function metaharnessSpanName(operation: string): string {
  return `cognitum.metaharness.${operation}`;
}

/** Builds the stable span name `cognitum.harnessaas.<operation>`. */
export function harnessaasSpanName(operation: string): string {
  return `cognitum.harnessaas.${operation}`;
}
