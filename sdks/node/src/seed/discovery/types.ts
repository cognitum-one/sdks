/**
 * Pluggable peer discovery (ADR-0016a §D6, ADR-0016b §"Discovery providers").
 *
 * Phase 1 required an explicit endpoint list; Phase 1.5 lifts that into
 * a `DiscoveryProvider` interface so the caller can swap between
 * explicit / mDNS / custom implementations without touching the rest
 * of the client API.
 *
 * Contract:
 *
 * - `discover()` returns the CURRENT candidate endpoints. SDKs call it
 *   once at construction and again inside {@link SeedClient.rediscover}.
 *   It is NOT called on every request — discovery is explicit, not
 *   scheduled (ADR-0016b §"Open" lifecycle).
 * - `close()` is optional; mDNS holds a long-lived UDP socket and
 *   SHOULD release it on {@link SeedClient.close}.
 *
 * Built-in providers live under `./explicit.ts` (always available) and
 * `./mdns.ts` (opt-in subpath `@cognitum/sdk/seed/discovery/mdns` — the
 * mDNS wire-library is declared as a `peerDependency` so the core
 * install stays lean).
 */

/**
 * One discovered peer. `url` is required; the remaining fields are
 * best-effort hints parsed from the source (e.g. mDNS TXT records per
 * `seed/src/cognitum-agent/src/discovery.rs:137-180`).
 */
export interface DiscoveredPeer {
  /** Normalised base URL, e.g. `"https://cognitum-61bc.local:8443"`. */
  url: string;
  /** Seed device UUID from the TXT `id=` record, when available. */
  deviceId?: string;
  /** Optional RTT hint (ms) — not currently populated by mDNS. */
  latencyMs?: number;
  /**
   * SHA-256 cert fingerprint advertised by the peer in its mDNS TXT
   * record (`fp=sha256:<hex>`, per ADR-0015c Phase 3 §fp= pinning and
   * `seed/src/cognitum-agent/src/discovery.rs:155-162` — FINDING-28).
   *
   * Canonical form: lowercase hexadecimal, no colons, no `sha256:`
   * prefix. The seed currently advertises only the first 16 hex chars
   * (8 bytes) per its bandwidth budget; the SDK accepts any length that
   * matches a byte-prefix of the peer's cert SHA-256.
   *
   * When set, the transport pins the TLS handshake to this fingerprint
   * — a mismatch throws {@link TlsPinError} with no fallback to
   * `tls.insecure`. `undefined` means "no mDNS-side pinning available";
   * the transport falls through to `tls.ca` / `tls.insecure` / system
   * CA per the configured precedence.
   */
  tlsFingerprint?: string;
}

/**
 * Producer of candidate seed endpoints. Implementations MUST be safe
 * to call `discover()` multiple times; each invocation returns a fresh
 * snapshot (callers do not share the returned array).
 */
export interface DiscoveryProvider {
  /** Return the current candidate seed endpoints. */
  discover(): Promise<DiscoveredPeer[]>;
  /**
   * Release long-running resources (e.g. the mDNS UDP socket). The SDK
   * invokes this from {@link SeedClient.close}; safe to omit for
   * stateless providers.
   */
  close?(): Promise<void> | void;
}
