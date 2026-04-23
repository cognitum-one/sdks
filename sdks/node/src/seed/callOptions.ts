/**
 * Per-call override knobs (ADR-0016b §"Per-call knobs", Phase 2).
 *
 * Every resource method (`status()`, `identity()`, `pair.*`, `witness.*`,
 * `custody.*`, `store.*`, `ota.*`, `mesh.*`) accepts a trailing
 * {@link CallOptions} bag. The pipeline in `SeedClient.request` honours:
 *
 * - `peer:` — force this one call to a named peer (canonical URL). If the
 *   peer isn't in the client's `PeerSet`, `request()` throws
 *   {@link ConfigError} before dispatch — the caller asked for something
 *   impossible, not a transient mesh failure. Overrides session-stickiness
 *   and routing preferences.
 * - `prefer:` — reorder the `PeerSet` for this call only. `"closest"` is
 *   the default (latency-then-listIndex); `"local-first"` prefers
 *   RFC-1918 / link-local hosts; `"random"` shuffles with a fresh seed
 *   each call; `"any"` is an alias for the default. Reordering does NOT
 *   mutate the long-lived `PeerSet` state.
 * - `consistency:` — `"session"` (default, sticky) / `"eventual"` /
 *   `"strong"`. `"strong"` throws {@link UnsupportedError} per
 *   ADR-0016a §D4 (seed has no quorum protocol today). `"eventual"`
 *   suppresses the session-sticky pin for this one call.
 * - `timeoutMs?:` — per-attempt read timeout override (ms).
 * - `retries?:` — retry count override; `null` explicitly disables retries
 *   for this one call (caller is attesting non-idempotent semantics).
 * - `signal?:` — standard `AbortSignal`. Cancels the underlying fetch;
 *   the pipeline surfaces the abort as a {@link NetworkError}.
 *
 * The shape mirrors `sdks/rust/src/seed/call_options.rs` so the three SDKs
 * stay diff-friendly.
 */

/** Peer-selection hint for a single call (ADR-0016b §Per-call knobs). */
export type CallPrefer = "closest" | "local-first" | "random" | "any";

/** Consistency hint for a single call (ADR-0016a §D4). */
export type CallConsistency = "session" | "eventual" | "strong";

/** Per-call override knobs. All fields optional. */
export interface CallOptions {
  /**
   * Pin this one call to `peer` (canonical URL — trailing slash is
   * tolerated). Throws {@link ConfigError} if `peer` isn't a configured
   * member of the client's `PeerSet`.
   */
  peer?: string;

  /** Peer ordering hint — see module docs. Default `"closest"`. */
  prefer?: CallPrefer;

  /**
   * Consistency hint. `"strong"` throws {@link UnsupportedError}
   * (ADR-0016a §D4); `"eventual"` disables session-stickiness for this
   * one call only.
   */
  consistency?: CallConsistency;

  /** Per-attempt read timeout override (ms). */
  timeoutMs?: number;

  /**
   * Per-call retry override. `null` explicitly disables retry for this
   * call (caller-attested non-idempotent semantics). Omit to use the
   * client-wide default.
   */
  retries?: number | null;

  /** Abort signal. Surfaces as {@link NetworkError} on fire. */
  signal?: AbortSignal;

  /**
   * Caller-attested idempotency hint. Forwarded to the request pipeline
   * unchanged; when omitted, the default is derived from the HTTP method.
   */
  idempotent?: boolean;
}
