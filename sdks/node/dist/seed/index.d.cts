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
type CallPrefer = "closest" | "local-first" | "random" | "any";
/** Consistency hint for a single call (ADR-0016a §D4). */
type CallConsistency = "session" | "eventual" | "strong";
/** Per-call override knobs. All fields optional. */
interface CallOptions {
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

/**
 * Per-peer pairing-token store (ADR-0016a §D5).
 *
 * Seed pairing is per-device: `DELETE /api/v1/pair/{client_name}` deletes
 * one client on one seed, so an SDK talking to N peers needs N potentially
 * distinct tokens. The {@link TokenBook} interface lets callers plug in
 * their own storage (OS keychain, encrypted file, test fixture); the
 * default {@link InMemoryTokenBook} holds tokens in a `Map` and wraps
 * every value in {@link SecretString} so `console.log` / `util.inspect`
 * never leaks the raw token.
 *
 * Mirror of `sdks/rust/src/seed/token_book.rs`.
 */
/**
 * Opaque pairing-token wrapper.
 *
 * The wire value is only exposed via {@link SecretString.reveal}. `toString`,
 * `toJSON`, and the custom `util.inspect` hook return `<redacted>` so the
 * token never appears in logs, stack traces, or serialised objects.
 */
declare class SecretString {
    #private;
    constructor(value: string);
    /**
     * Borrow the inner token. Use sparingly — never log the result.
     */
    reveal(): string;
    /** Whether the underlying string is empty. */
    isEmpty(): boolean;
    /** Length of the underlying string (exposed for diagnostics). */
    get length(): number;
    toString(): string;
    toJSON(): string;
}
/**
 * Peer-keyed pairing-token store. Implementations MUST key on a normalised
 * peer URL (use {@link normaliseBaseUrl} from `peers.ts`). All methods
 * are synchronous — callers that need async storage should wrap a
 * cached-on-read abstraction around this interface.
 */
interface TokenBook {
    /**
     * Look up the token for `peerUrl`. Returns `undefined` when no pairing
     * exists for that peer (the call will either surface `AuthError` or
     * proceed unauthenticated against WiFi-read endpoints).
     */
    get(peerUrl: string): SecretString | undefined;
    /**
     * Store `token` under `peerUrl`. Overwrites any previous value.
     */
    set(peerUrl: string, token: SecretString): void;
    /**
     * Forget the token for `peerUrl`. Idempotent — safe to call when the
     * peer has no entry.
     */
    delete(peerUrl: string): void;
}
/**
 * Default in-memory implementation. Not persisted; tokens vanish when
 * the owning {@link SeedClient} is garbage-collected.
 */
declare class InMemoryTokenBook implements TokenBook {
    #private;
    /**
     * Build a book from an iterable of `[peerUrl, token]` pairs. Raw
     * strings are promoted to {@link SecretString} automatically.
     */
    static fromEntries(entries: Iterable<readonly [string, string | SecretString]>): InMemoryTokenBook;
    get(peerUrl: string): SecretString | undefined;
    set(peerUrl: string, token: SecretString): void;
    delete(peerUrl: string): void;
    /** Number of entries; exposed for tests and introspection. */
    get size(): number;
}
/**
 * Pair `clientName` against every peer referenced by `book`, using the
 * caller-supplied `pair` helper. The helper is expected to call
 * `POST /api/v1/pair` against one specific peer and return the response
 * body; this shape keeps `tokenBook.ts` free of HTTP concerns while still
 * giving callers a one-shot mesh-pairing convenience.
 *
 * Returns the list of `[peerUrl, response]` pairs in iteration order.
 * Errors from the `pair` helper propagate — callers decide whether to
 * retry individual peers.
 *
 * Mirrors the `pair_all` helper proposed in ADR-0016a §D5.
 */
declare function pairAll<R extends {
    token?: string;
    pairing_token?: string;
}>(peers: readonly string[], clientName: string, pair: (peerUrl: string, clientName: string) => Promise<R>, book?: TokenBook): Promise<Array<readonly [string, R]>>;

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
interface DiscoveredPeer {
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
interface DiscoveryProvider {
    /** Return the current candidate seed endpoints. */
    discover(): Promise<DiscoveredPeer[]>;
    /**
     * Release long-running resources (e.g. the mDNS UDP socket). The SDK
     * invokes this from {@link SeedClient.close}; safe to omit for
     * stateless providers.
     */
    close?(): Promise<void> | void;
}

/**
 * Peer set management (Phase 1.5).
 *
 * ADR-0016a §D2 / §D7: a [`PeerSet`] of one or more peers with per-peer
 * health / latency tracking. `pick()` selects the "closest-first" peer;
 * `nextAfter(failed)` supplies the next candidate for the failover state
 * machine in `SeedClient.request()`.
 *
 * Kept deliberately free of HTTP concerns — the client layer records
 * outcomes via `markSuccess` / `markFailure`, and this module just
 * maintains the ordering invariants.
 */
/** Routing-layer peer health state (ADR-0016a §D7). */
type PeerState = "healthy" | "degraded" | "unhealthy";
/**
 * Error class observed on a peer-level request outcome. Informs the
 * failure bookkeeping in [`PeerSet.markFailure`].
 */
type PeerErrorClass = "network" | "timeout" | "server5xx" | "serviceUnavailable";
/** One configured seed endpoint plus its latency / health state. */
interface Peer {
    /** Constructor-order index (stable regardless of sort order). */
    readonly listIndex: number;
    /** Normalised base URL (no trailing slash). */
    readonly baseUrl: string;
    /** Canonical key (same as `baseUrl` today; kept distinct for clarity). */
    readonly key: string;
    /** Short `host:port` label for logs. */
    readonly label: string;
    /** Routing-layer health state. */
    state: PeerState;
    /**
     * Exponential moving average of observed latency in ms. `undefined`
     * until the first successful observation.
     */
    latencyEmaMs: number | undefined;
    /** Timestamp (ms since epoch) of the last dispatch attempt. */
    lastUsedAt: number | undefined;
    /** Consecutive failures — degraded at >=1, unhealthy at >=3. */
    consecutiveFailures: number;
    /**
     * Pinned SHA-256 TLS cert fingerprint for this peer (hex, lowercase,
     * no colons / no `sha256:` prefix). Populated from the mDNS TXT
     * record's `fp=` field. When set, the transport layer pins the TLS
     * handshake to this fingerprint (ADR-0015c Phase 3 §fp= cert
     * pinning). `undefined` means no mDNS-side pin is in effect — the
     * normal `tls.ca` / `tls.insecure` precedence applies.
     */
    readonly tlsFingerprint: string | undefined;
}
/** Optional per-peer metadata plumbed into the {@link PeerSet} at construction. */
interface PeerOptions {
    /** SHA-256 cert fingerprint (hex, lowercase) — see {@link Peer.tlsFingerprint}. */
    tlsFingerprint?: string;
}
/**
 * Ordered peer table. Phase 1 accepts one endpoint; Phase 1.5 accepts
 * 1..N and maintains health/latency per peer.
 */
declare class PeerSet {
    private readonly peers;
    constructor(endpoints: readonly string[], peerOptions?: readonly (PeerOptions | undefined)[]);
    /** Total peer count. */
    len(): number;
    /** Whether more than one peer is configured. */
    isMesh(): boolean;
    /** Snapshot of all peers (shallow copy so callers can't mutate state). */
    snapshot(): Peer[];
    /** Primary peer — the first in constructor order. */
    primary(): Peer;
    /** Iterator over peers in constructor order. */
    iter(): IterableIterator<Peer>;
    /**
     * Pick the next peer to dispatch against per closest-first ordering.
     * Prefers `healthy` → `degraded`; falls back to `unhealthy` only if
     * every peer is unhealthy (so the request still attempts something).
     */
    pick(): Peer;
    /**
     * Next peer to try after `failed` has returned a cycling-eligible
     * error. Skips `failed` by `listIndex`; scans remaining peers in the
     * same closest-first order.
     */
    nextAfter(failed: Peer): Peer | undefined;
    /** Look up a peer by canonical URL key. */
    findByKey(peerKey: string): Peer | undefined;
    /**
     * Reset every peer's per-session state so the next `pick()` is driven
     * purely by `listIndex` again. Used by `SeedClient.rediscover()` to
     * re-prime the table after a caller has rotated credentials / rebuilt
     * the peer list. Does NOT remove peers; does NOT touch the TokenBook.
     */
    resetAll(): void;
    /**
     * Return a one-call ordered view per {@link CallPrefer} — used by the
     * per-call `prefer:` knob in the request pipeline. Does NOT mutate
     * the underlying table.
     *
     * - `"closest"` / `"any"` — default closest-first ordering.
     * - `"local-first"` — RFC-1918 / link-local hosts first, then the
     *   closest-first ordering for the remainder.
     * - `"random"` — Fisher-Yates shuffle with `Math.random`.
     */
    preferOrder(mode: "closest" | "local-first" | "random" | "any"): Peer[];
    /**
     * Record a successful outcome: update EMA, clear failure counter,
     * promote state to `healthy`.
     */
    markSuccess(peerKey: string, latencyMs: number): void;
    /**
     * Record a failure. `class` determines the state transition:
     *
     * - `serviceUnavailable` — immediate `unhealthy` (lockdown semantics).
     * - `network` / `timeout` / `server5xx` — bumps `consecutiveFailures`;
     *   `degraded` at 1-2, `unhealthy` at >=3.
     */
    markFailure(peerKey: string, cls: PeerErrorClass): void;
    private peerMut;
}
/**
 * Normalise a URL into the canonical `https://host:port[/path]` shape
 * with no trailing slash. Throws `ConfigError` on invalid input.
 */
declare function normaliseBaseUrl(raw: string): string;

/**
 * Seed client configuration.
 *
 * Phase 1.5 (2026-04-22) accepts 1..N endpoints and adds `tokenBook`,
 * `routing`, `failover`, and `healthInterval` options. A single endpoint
 * still behaves exactly like Phase 1 — the mesh code paths degenerate
 * to the old single-peer loop when `endpoints.length === 1`.
 */
/** Single endpoint form; canonical host `https://cognitum.local:8443`. */
type SeedEndpoint = string;
/**
 * Inline multi-identity token map: `{ [clientName]: token }`. Supplied
 * via {@link SeedAuthOptions.pairingToken}; converted into the per-peer
 * {@link TokenBook} at resolution time if no explicit book is provided.
 *
 * Deprecated for Phase 1.5: prefer passing a full {@link TokenBook}
 * instance via {@link SeedClientOptions.tokenBook}. Kept for backwards
 * compatibility with Phase 1 test fixtures.
 */
interface InlineTokenMap {
    [clientName: string]: string;
}
interface SeedAuthOptions {
    /**
     * Raw pairing-token string (single-identity mode). When the caller
     * also supplies `tokenBook`, that book's per-peer entries take
     * priority and this acts as a fallback.
     */
    pairingToken?: string | InlineTokenMap;
    /** Legacy / cloud-bridge API key. Not used by the seed itself. */
    apiKey?: string;
}
interface SeedTlsOptions {
    /** Custom CA PEM (string or Buffer) for non-pinned hosts. */
    ca?: Buffer | string;
    /** Dev-only: disable TLS verification. Logs a one-time warning. */
    insecure?: boolean;
}
/**
 * Routing strategy across peers (ADR-0016a §D2). Phase 1.5 ships
 * `"session"` (closest-first with session-stickiness) as the default;
 * explicit values pre-reserve the surface for future per-call knobs.
 */
type SeedRouting = "pinned" | "session" | "round-robin" | "read-any-write-one";
interface SeedFailoverOptions {
    onConnectError?: "next-peer" | "retry-same";
    onStatus5xx?: "next-peer" | "retry-same" | "propagate";
}
interface SeedTimeoutOptions {
    /** Per-attempt connect timeout (ms). Default 5000. */
    connect?: number;
    /** Per-attempt read timeout (ms). Default 30_000. */
    read?: number;
    /** Total elapsed budget (ms) across all attempts. Default 60_000 per ADR-0005. */
    total?: number;
}
interface SeedClientOptions {
    /**
     * One endpoint (single-seed mode), a list (mesh mode, Phase 1.5), OR
     * a {@link DiscoveryProvider} (Phase 1.5 opt-in, e.g. `MdnsDiscovery`
     * from `@cognitum/sdk/seed/discovery/mdns`).
     *
     * For the array form, order is preserved as the peer `listIndex` for
     * tie-breaking in the closest-first picker. Providers are evaluated
     * at construction (and again on {@link SeedClient.rediscover}); the
     * resolved peer list is treated the same as the explicit form.
     */
    endpoints: SeedEndpoint | SeedEndpoint[] | DiscoveryProvider;
    auth?: SeedAuthOptions;
    tls?: SeedTlsOptions;
    /**
     * Explicit per-peer {@link TokenBook}. When omitted, the client
     * allocates an {@link InMemoryTokenBook} and seeds it from
     * `auth.pairingToken` (if a string) for every peer.
     */
    tokenBook?: TokenBook;
    /** Routing strategy across peers. Default `"session"` (Phase 1.5). */
    routing?: SeedRouting;
    failover?: SeedFailoverOptions;
    timeouts?: SeedTimeoutOptions;
    /** Max retry attempts beyond the first. Default 3 per ADR-0005. */
    retries?: number;
    /** Honour 429 `Retry-After` + `retry_after_us` and retry. Default true. */
    rateLimitRetry?: boolean;
    /**
     * Active health-probe interval in milliseconds. Default: disabled.
     * When set, the client pings `GET /api/v1/status` on every peer on
     * this cadence (ADR-0016a §D7).
     */
    healthInterval?: number;
    /** Test-only: inject a custom `fetch` (e.g. vitest mock). */
    fetch?: typeof fetch;
    /** Optional logger — receives redacted records. */
    logger?: {
        warn?: (msg: string) => void;
        debug?: (rec: unknown) => void;
    };
}
/** Resolved, validated, defaulted config — consumed by SeedClient internals. */
interface ResolvedSeedConfig {
    /**
     * Normalised endpoint list in caller order. At least one element.
     * For single-endpoint mode the first element is also exposed as
     * {@link ResolvedSeedConfig.baseUrl}.
     */
    endpoints: string[];
    /**
     * Canonical single-peer URL — convenience accessor identical to
     * `endpoints[0]`. Kept so Phase 1 call-sites keep compiling.
     */
    baseUrl: string;
    /**
     * Client-wide fallback pairing token. When a per-peer `tokenBook`
     * entry exists it wins; this field is only consulted when the book
     * has no entry for the dispatching peer.
     */
    pairingToken: string | undefined;
    /**
     * Inline multi-identity map (legacy). Present only when the caller
     * passed `auth.pairingToken` as an object; the resolver does NOT
     * promote it to the `TokenBook` automatically — use `tokenBook`
     * for that.
     */
    pairingTokenMap: InlineTokenMap | undefined;
    apiKey: string | undefined;
    tls: {
        ca: Buffer | string | undefined;
        insecure: boolean;
    };
    routing: SeedRouting;
    failover: Required<SeedFailoverOptions>;
    timeouts: Required<SeedTimeoutOptions>;
    retries: number;
    rateLimitRetry: boolean;
    /** Explicit token book (only when caller supplied one). */
    tokenBook: TokenBook | undefined;
    /** Active health-probe interval in ms, or `undefined` when disabled. */
    healthInterval: number | undefined;
    /**
     * Discovery provider attached to this client (ADR-0016a §D6). Non-`undefined`
     * when the caller supplied a {@link DiscoveryProvider} either directly in
     * `endpoints:` or via the async {@link SeedClient.create} factory.
     * {@link SeedClient.rediscover} re-invokes `discover()` when this is set.
     */
    discovery: DiscoveryProvider | undefined;
    /**
     * Parallel to `endpoints`: per-peer options (mDNS cert fingerprint,
     * etc.). `peerOptions[i]` corresponds to `endpoints[i]`. Present only
     * when {@link SeedClient.create} pre-resolved a {@link DiscoveryProvider}
     * that reported `tlsFingerprint` on one or more peers. Undefined for
     * explicit-list callers (no per-peer options available).
     */
    peerOptions: readonly (PeerOptions | undefined)[] | undefined;
    fetchFn: typeof fetch;
    logger: {
        warn?: (msg: string) => void;
        debug?: (rec: unknown) => void;
    };
}

/** GET /api/v1/custody/epoch — Phase 1 resource. */

interface CustodyEpoch extends Record<string, unknown> {
    epoch: number;
}
interface CustodyResource {
    /** GET /api/v1/custody/epoch — WiFi-read allowlist. */
    epoch(opts?: CallOptions): Promise<CustodyEpoch>;
}

/** GET /api/v1/identity — Phase 1 resource. */

interface SeedIdentity extends Record<string, unknown> {
    device_id: string;
    /** Public key in hex or base64 — seed-dependent. */
    public_key?: string;
    firmware_version?: string;
    epoch?: number;
}
interface IdentityResource {
    (opts?: CallOptions): Promise<SeedIdentity>;
    get(opts?: CallOptions): Promise<SeedIdentity>;
}

/**
 * Mesh observability wire shapes (ADR-0016a §D8 "Phase 1 surface addendum").
 *
 * Wire-verified (2026-04-22) against live seed v0.20.0 on the gadget
 * endpoint at `https://169.254.42.1:8443`:
 *
 * - `GET /api/v1/network/mesh/status` →
 *   `{"ap_active":true,"auto_mesh":false,"connected_to_seed":false,
 *     "device_id":"...","has_mesh_password":false,"peer_count":0,"peers":[]}`
 * - `GET /api/v1/peers` →
 *   `{"count":0,"discovery_active":true,"peers":[]}`
 * - `GET /api/v1/swarm/status` →
 *   `{"device_id":"...","discovery_active":true,"epoch":20564,
 *     "peer_count":0,"total_vectors":8460,"uptime_secs":23000}`
 * - `GET /api/v1/cluster/health` →
 *   `{"auto_sync_interval_secs":60,"cluster_enabled":true,
 *     "discovery_active":true,"last_sync_attempt":1776906537,
 *     "peer_count":0,"peers":[]}`
 *
 * Every interface extends `Record<string, unknown>` so new seed-side
 * fields are forward-compatible per ADR-0006 §"unknown fields are
 * preserved".
 */
/** One peer entry as exposed by seed-side mesh observability endpoints. */
interface MeshPeerEntry extends Record<string, unknown> {
    /** Device-id (UUID) reported by the seed. */
    device_id?: string;
    /** Peer address (IP:port) when known. */
    address?: string;
    /** Peer epoch (last successful pull). */
    epoch?: number;
    /** Last-seen timestamp (seconds since Unix epoch) when known. */
    last_seen?: number;
    /** Vector count snapshot when known. */
    total_vectors?: number;
}
/** `GET /api/v1/network/mesh/status` — mesh overlay health snapshot. */
interface MeshStatus extends Record<string, unknown> {
    /** AP (access-point) mode active on the seed. */
    ap_active?: boolean;
    /** Whether auto-mesh join is enabled. */
    auto_mesh?: boolean;
    /** Reachable from the primary/hub seed. */
    connected_to_seed?: boolean;
    /** Device-id (UUID) of the seed answering. */
    device_id?: string;
    /** A mesh password has been provisioned. */
    has_mesh_password?: boolean;
    /** Number of peers currently known to this seed. */
    peer_count?: number;
    /** Per-peer detail (may be empty on a lone seed). */
    peers?: MeshPeerEntry[];
}
/** `GET /api/v1/peers` — discovery view. */
interface MeshPeers extends Record<string, unknown> {
    count?: number;
    discovery_active?: boolean;
    peers?: MeshPeerEntry[];
}
/** `GET /api/v1/swarm/status` — swarm coordination state. */
interface SwarmStatus extends Record<string, unknown> {
    device_id?: string;
    discovery_active?: boolean;
    epoch?: number;
    peer_count?: number;
    total_vectors?: number;
    uptime_secs?: number;
}
/** `GET /api/v1/cluster/health` — cluster-level aggregate. */
interface ClusterHealth extends Record<string, unknown> {
    auto_sync_interval_secs?: number;
    cluster_enabled?: boolean;
    discovery_active?: boolean;
    last_sync_attempt?: number;
    peer_count?: number;
    peers?: MeshPeerEntry[];
}

/**
 * Mesh observability resource (ADR-0016a §D8 Phase 1 surface addendum).
 *
 * Four read-only seed endpoints that make the mesh observable from an
 * SDK consumer. All four are WiFi-read allowlist endpoints — no pairing
 * token required (see `seed/src/cognitum-agent/src/api.rs:392-400`).
 *
 * Wire shapes verified against live seed v0.20.0 on 2026-04-22 — see
 * `../models/mesh.ts` for JSON samples.
 */

interface MeshResource {
    /**
     * `GET /api/v1/network/mesh/status` — overlay health snapshot.
     *
     * Returns `{ ap_active, auto_mesh, connected_to_seed, device_id,
     * has_mesh_password, peer_count, peers }`. A single-seed install
     * reports `peer_count: 0, peers: []`.
     */
    status(opts?: CallOptions): Promise<MeshStatus>;
    /**
     * `GET /api/v1/peers` — list of known mesh peers as exposed by
     * the seed's discovery layer (`_cognitum._tcp.local` mDNS +
     * gossip). Returns `{ count, discovery_active, peers }`.
     */
    peers(opts?: CallOptions): Promise<MeshPeers>;
    /**
     * `GET /api/v1/swarm/status` — swarm coordination state (epoch,
     * peer count, local vector count snapshot).
     */
    swarmStatus(opts?: CallOptions): Promise<SwarmStatus>;
    /**
     * `GET /api/v1/cluster/health` — cluster-level aggregate.
     *
     * Returns `{ auto_sync_interval_secs, cluster_enabled,
     * discovery_active, last_sync_attempt, peer_count, peers }`.
     */
    clusterHealth(opts?: CallOptions): Promise<ClusterHealth>;
}

/** OTA config + check-now — Phase 1 resources. */

interface OtaConfig extends Record<string, unknown> {
    channel?: string;
    auto_update?: boolean;
    check_interval_secs?: number;
}
interface OtaCheckResponse extends Record<string, unknown> {
    update_available?: boolean;
    current_version?: string;
    latest_version?: string;
    checked_at?: string;
}
interface OtaResource {
    /** GET /api/v1/ota/config — WiFi-read allowlist. */
    config(opts?: CallOptions): Promise<OtaConfig>;
    /** POST /api/v1/ota/check-now — idempotent probe; safe to retry. */
    checkNow(opts?: CallOptions): Promise<OtaCheckResponse>;
}

/** Pairing resource — POST/DELETE/GET on /api/v1/pair. */

interface PairStatus extends Record<string, unknown> {
    paired: boolean;
    client_count?: number;
    pairing_window_open?: boolean;
    window_remaining_secs?: number;
}
interface PairCreateParams {
    /** Human-readable name for this client/device. */
    clientName: string;
}
/**
 * Typed response from {@link PairResource.create}. The pairing token is
 * wrapped in a {@link SecretString} — it redacts itself when serialised
 * (`JSON.stringify` → `"<redacted>"`), stringified, or inspected by
 * Node's `util.inspect`. Call `.reveal()` to obtain the raw string at
 * the one-and-only write site (e.g. `tokenBook.set(url, token)`).
 *
 * The plain-string `pairing_token` field is deliberately omitted — the
 * earlier shape where it appeared as a top-level string was removed to
 * close issue cognitum-one/sdks#15 (token leaks via default logging).
 */
interface PairCreateResponse {
    /** Echoed client name (seed returns it verbatim). */
    client_name: string;
    /**
     * Redacted pairing token. Use `.reveal()` to get the raw string —
     * typically `book.set(peerUrl, response.token)`.
     */
    token: SecretString;
    /** ISO-8601 expiry, when the seed provided one. */
    expires_at?: string;
}
interface PairResource {
    /** GET /api/v1/pair/status — WiFi-read allowlist. */
    status(opts?: CallOptions): Promise<PairStatus>;
    /** POST /api/v1/pair — open pairing window must be active. */
    create(params: PairCreateParams, opts?: CallOptions): Promise<PairCreateResponse>;
    /** DELETE /api/v1/pair/{name} — revoke a named client. */
    delete(clientName: string, opts?: CallOptions): Promise<void>;
}

/** GET /api/v1/status — Phase 1 resource. */

/** Wire-verified response shape (2026-04-22 against seed v0.20.0). */
interface SeedStatus extends Record<string, unknown> {
    device_id: string;
    uptime_secs: number;
    epoch: number;
    total_vectors: number;
    deleted_vectors: number;
    file_size_bytes: number;
    dimension: number;
    paired: boolean;
    roles: string[];
    /** Optional — present on newer firmwares. */
    witness_chain_length?: number;
}
interface StatusResource {
    /** Fetch seed status (idempotent, WiFi-allowlist endpoint). */
    (opts?: CallOptions): Promise<SeedStatus>;
    /** Alias: `client.status()` reads ergonomically as a call OR member. */
    get(opts?: CallOptions): Promise<SeedStatus>;
}

/** Vector store — status / query / ingest. */

interface StoreStatus extends Record<string, unknown> {
    total_vectors: number;
    deleted_vectors: number;
    dimension: number;
    file_size_bytes?: number;
    epoch?: number;
}
/**
 * Query payload — swarm-verified (2026-04-22): the seed expects
 * `{ vector: number[], k: number }`, NOT `{ query, k }`. An earlier
 * version of ADR-0015a mis-documented the field name; this binding is
 * the source of truth until the ADR is updated.
 */
interface StoreQueryParams {
    vector: number[];
    k: number;
    /** Optional distance metric hint. */
    metric?: "cosine" | "euclidean" | "dot";
}
interface StoreQueryHit extends Record<string, unknown> {
    id: number | string;
    distance: number;
    metadata?: Record<string, unknown>;
}
interface StoreQueryResponse extends Record<string, unknown> {
    results: StoreQueryHit[];
    query_ms?: number;
}
interface StoreIngestItem {
    /** Optional content-hash / user-supplied id. */
    id?: string;
    values: number[];
    metadata?: Record<string, unknown>;
}
interface StoreIngestParams {
    vectors: StoreIngestItem[];
}
interface StoreIngestResponse extends Record<string, unknown> {
    ingested: number;
    witness_chain_length?: number;
    epoch?: number;
}
interface StoreResource {
    /** GET /api/v1/store/status — WiFi-read allowlist. */
    status(opts?: CallOptions): Promise<StoreStatus>;
    /** POST /api/v1/store/query — treated as idempotent for retry purposes. */
    query(params: StoreQueryParams, opts?: CallOptions): Promise<StoreQueryResponse>;
    /** POST /api/v1/store/ingest — not idempotent; no retry on read-timeout. */
    ingest(params: StoreIngestParams, opts?: CallOptions): Promise<StoreIngestResponse>;
}

/** GET /api/v1/witness/chain — Phase 1 resource. */

interface WitnessEntry extends Record<string, unknown> {
    epoch: number;
    action?: string;
    signature?: string;
    timestamp?: string;
}
interface WitnessChain extends Record<string, unknown> {
    entries?: WitnessEntry[];
    length?: number;
    head?: string;
}
interface WitnessResource {
    /** GET /api/v1/witness/chain — WiFi-read allowlist. */
    chain(opts?: CallOptions): Promise<WitnessChain>;
}

/**
 * Seed session handle (ADR-0016a §D9).
 *
 * A {@link SeedSession} pins one peer for the duration of its lifetime so
 * reads and writes land on the same seed (read-your-writes within a
 * session — ADR-0016a §D4). The handle mirrors the resource accessors
 * on {@link SeedClient}; all requests issued through it route to the
 * pinned peer unless the peer fails hard, in which case the request
 * loop's failover state machine transparently cycles (per ADR-0016a §D3).
 *
 * The pin is advisory — enforced at dispatch time in `SeedClient.request`
 * via the `pinnedPeerKey` option. Dropping a session does not mutate the
 * client; it simply releases the caller's reference.
 *
 * Mirror of `sdks/rust/src/seed/session.rs`.
 */

/**
 * One-peer session. Pins reads + writes to `pinnedPeer` via an
 * implementation-level request hook on the owning {@link SeedClient}.
 */
declare class SeedSession {
    /** Canonical URL key of the pinned peer (no trailing slash). */
    readonly pinnedPeer: string;
    /** GET /api/v1/status on the pinned peer. */
    readonly status: StatusResource;
    /** GET /api/v1/identity on the pinned peer. */
    readonly identity: IdentityResource;
    /** Pairing resource on the pinned peer. */
    readonly pair: PairResource;
    /** Witness resource on the pinned peer. */
    readonly witness: WitnessResource;
    /** Custody resource on the pinned peer. */
    readonly custody: CustodyResource;
    /** Store resource on the pinned peer. */
    readonly store: StoreResource;
    /** OTA resource on the pinned peer. */
    readonly ota: OtaResource;
    /** Mesh observability — read endpoints routed through the pinned peer. */
    readonly mesh: MeshResource;
    /** @internal — constructed by {@link SeedClient.session}. */
    constructor(client: SeedClient, pinnedPeer: string);
}

/**
 * SeedClient — Phase 1.5 mesh-aware implementation. Composes `config.ts`,
 * `peers.ts`, `tokenBook.ts`, `session.ts`, `health.ts`, `transport.ts`,
 * `retry.ts`, and the ADR-0004 error taxonomy in `../errors.ts`.
 *
 * Failover state machine (ADR-0016a §D3, ADR-0017 §Step 4):
 * NetworkError / TimeoutError / 500 / 502 / 503 / 504 → mark peer, cycle
 * via `PeerSet.nextAfter`, else fall through to ADR-0005 retry. 429 → pin
 * on the same peer, honour `Retry-After` / `retry_after_us`, apply
 * equal-jitter backoff (trust-score protection — do NOT cycle). 4xx
 * auth / validation / not-found / 501 → surface immediately. The 60 s
 * total-elapsed budget covers ALL peer attempts combined — N peers × M
 * retries is NOT allowed (invariant I10).
 */

/** Options passed to {@link SeedClient.request} per call. */
interface SeedRequestOptions extends CallOptions {
    /** JSON body to serialise; omit for GET/DELETE. */
    body?: unknown;
    /** Extra query parameters. */
    query?: Record<string, string | number | boolean | undefined>;
    /**
     * Pin this one request to `peerKey` (canonical URL, no trailing
     * slash). Used by {@link SeedSession}; the failover state machine
     * still cycles when the pinned peer hard-fails. Distinct from the
     * {@link CallOptions.peer} per-call override — `pinnedPeerKey` is
     * set by the session handle and silently no-ops when the peer isn't
     * in the set, whereas `peer` is caller-facing and throws
     * {@link ConfigError} when the peer is unknown.
     */
    pinnedPeerKey?: string;
}
/**
 * Phase 1.5 seed client — supports 1..N peers with closest-first
 * routing + failover state machine.
 *
 * @example
 * ```ts
 * import { SeedClient } from "@cognitum/sdk/seed";
 *
 * const client = new SeedClient({
 *   endpoints: ["https://seed-a:8443", "https://seed-b:8443"],
 *   auth: { pairingToken: process.env.COGNITUM_SEED_TOKEN },
 *   tls: { insecure: true }, // dev only
 *   healthInterval: 30_000,  // opt-in active probe
 * });
 *
 * // Mesh-aware read:
 * const status = await client.status();
 *
 * // Session pins both to the same peer:
 * const session = client.session();
 * await session.store.ingest({ vectors: [{ values: [1,2,3] }] });
 * await session.store.query({ vector: [1,2,3], k: 1 });
 *
 * client.close(); // stop active health probe, if any
 * ```
 */
declare class SeedClient {
    /** Resolved config (read-only snapshot). */
    readonly config: ResolvedSeedConfig;
    /** GET /api/v1/status */
    readonly status: StatusResource;
    /** GET /api/v1/identity */
    readonly identity: IdentityResource;
    /** Pairing — create / status / delete. */
    readonly pair: PairResource;
    /** GET /api/v1/witness/chain + related. */
    readonly witness: WitnessResource;
    /** GET /api/v1/custody/epoch. */
    readonly custody: CustodyResource;
    /** Vector store — status / query / ingest. */
    readonly store: StoreResource;
    /** OTA — config + check-now. */
    readonly ota: OtaResource;
    /**
     * Mesh observability — `status()`, `peers()`, `swarmStatus()`,
     * `clusterHealth()` (ADR-0016a §D8). Read-only; all four are on the
     * seed's WiFi-read allowlist so no pairing token is needed.
     */
    readonly mesh: MeshResource;
    /**
     * Peer set — closest-first picker with per-peer health state.
     * Re-assigned (not mutated) by {@link SeedClient.rediscover} when a
     * discovery provider returns a fresh peer list; the reference-swap
     * keeps the data structure's internal invariants tidy without needing
     * a separate "replace" method on {@link PeerSet}.
     */
    private peerSet;
    /** Per-peer pairing-token store. */
    private readonly tokenBook;
    /** TLS-aware fetch bound to this client. */
    private readonly fetchFn;
    /**
     * Per-peer dispatcher factory (ADR-0015c Phase 3 §fp= cert pinning).
     * Returns a pinned undici Agent when the peer carries an mDNS
     * fingerprint; `undefined` otherwise (→ client-wide dispatcher
     * applies). Memoised inside the factory — one Agent per peer for the
     * client's lifetime.
     */
    private readonly peerDispatcher;
    /** Active health-probe handle; `undefined` when disabled. */
    private readonly healthProbe;
    /**
     * Per-peer consecutive-AuthError counter — ADR-0007 §"Trust-score
     * protection", closes cognitum-one/sdks#16. The seed locks a client
     * out after 3 failed auth attempts; we abort on the 3rd so the caller
     * never burns the seed's budget. Reset to 0 on any 2xx from the same
     * peer, or explicitly via {@link SeedClient.resetTrustScore}.
     */
    private readonly authFailures;
    /** Trust-score threshold — 3 consecutive auth failures triggers block. */
    private static readonly TRUST_SCORE_LIMIT;
    /**
     * Attached discovery provider (ADR-0016a §D6). When set,
     * {@link SeedClient.rediscover} re-invokes `discover()` and rebuilds
     * the {@link PeerSet} with the fresh entries. `undefined` for
     * explicit-list clients.
     */
    private readonly discovery;
    /**
     * Async factory that resolves a {@link DiscoveryProvider} before
     * constructing the client. Use this when `options.endpoints` is a
     * provider (e.g. `MdnsDiscovery`) — the sync constructor rejects
     * providers because `discover()` is async.
     *
     * For explicit-list callers the sync constructor still works; this
     * factory is only needed for the Phase 1.5 opt-in discovery path.
     *
     * @example
     * ```ts
     * import { SeedClient } from "@cognitum/sdk/seed";
     * import { MdnsDiscovery } from "@cognitum/sdk/seed/discovery/mdns";
     *
     * const client = await SeedClient.create({
     *   endpoints: MdnsDiscovery.default(),
     *   tls: { insecure: true },
     * });
     * ```
     */
    static create(options: SeedClientOptions): Promise<SeedClient>;
    constructor(options: SeedClientOptions);
    /**
     * Snapshot view of the SDK-local peer table (ADR-0016a §D7 —
     * `client.peers()`). The returned array is a shallow copy; mutations
     * do not affect routing.
     */
    peers(): Peer[];
    /**
     * Open a {@link SeedSession} pinned to the currently closest-first
     * peer. The session holds the pin for its lifetime; all its resource
     * calls go to the same peer unless the peer hard-fails, in which case
     * the failover state machine transparently cycles.
     */
    session(): SeedSession;
    /**
     * Stop the active health probe (if any) and close the attached
     * discovery provider (if any) so the Node event loop can exit
     * cleanly. Idempotent — safe to call more than once.
     *
     * The discovery provider's `close()` is awaited only when the caller
     * awaits the returned value; sync callers still get a best-effort
     * teardown (mDNS sockets are set to `unref` on the wire layer).
     *
     * Does NOT revoke pairing or wipe the TokenBook; callers own token
     * lifetimes per ADR-0007.
     */
    close(): void | Promise<void>;
    /**
     * Rebuild the per-peer routing state from scratch (ADR-0016a §D7
     * "rediscover"). Resets every peer's {@link Peer.state} to `"healthy"`,
     * clears `latencyEmaMs`, zeroes `consecutiveFailures`, and re-sorts
     * the table so the next `request()` is driven by constructor order.
     *
     * Use this after rotating pairing tokens or when the caller knows the
     * previous failure bookkeeping is stale (e.g. the mesh transport
     * recovered out-of-band from a brown-out). Idempotent — calling it
     * multiple times in a row is a no-op beyond the first.
     *
     * No discovery provider: returns `void` synchronously (reset only).
     * With a discovery provider attached (ADR-0016a §D6): returns a
     * `Promise<void>` that resolves after the provider has been
     * re-queried and the {@link PeerSet} rebuilt with the fresh entries.
     * Providers that return zero peers are treated as a no-op — the
     * previous peer set is preserved so the client never becomes
     * un-routable as a side-effect of a transient multicast drop.
     */
    rediscover(): void | Promise<void>;
    /**
     * Re-query the attached discovery provider, normalise results, and
     * splice them into the peer table. Preserves tokens for URLs that
     * are still present; ejects tokens for URLs that have dropped out.
     * @internal
     */
    private rediscoverFromProvider;
    /**
     * Introspection helper for tests: look up a pairing token by
     * canonical peer URL. Returns `undefined` when the book has no entry.
     * @internal
     */
    tokenForPeer(peerKey: string): string | undefined;
    /**
     * Clear the trust-score counter for a single peer (or, with no
     * argument, every peer). Call this after the caller has rotated the
     * pairing token or otherwise resolved the auth failure that triggered
     * the block — without a reset, the client will keep refusing further
     * requests to that peer to protect the seed's trust-score budget.
     *
     * @param peerKey — canonical peer URL to clear. If omitted, clears
     *   every peer's counter.
     */
    resetTrustScore(peerKey?: string): void;
    /**
     * Current trust-score counter for `peerKey`. Exposed for tests; the
     * public API surface should consume {@link TrustScoreBlockedError}
     * from `request()` rather than polling this number.
     * @internal
     */
    trustScoreFailures(peerKey: string): number;
    /**
     * Perform an HTTP request against the seed mesh and return the parsed
     * JSON body. Implements the Phase 1.5 failover state machine.
     */
    request<T>(method: string, path: string, opts?: SeedRequestOptions): Promise<T>;
    private initialPeer;
    private shouldBackoffRetry;
    private backoffDelay;
    private dispatchOnce;
}

/**
 * Active health probe (ADR-0016a §D7, opt-in).
 *
 * Off by default. When the caller sets `healthInterval` on
 * {@link SeedClientOptions}, the client spawns a `setInterval` that pings
 * `GET /api/v1/status` on every configured peer. Outcomes feed
 * {@link PeerSet.markSuccess} / {@link PeerSet.markFailure} so routing
 * reflects the probe view even when the caller is idle.
 *
 * The interval is unref'd so it never keeps the Node process alive. The
 * handle returned by {@link startHealthProbe} is owned by `SeedClient`
 * and stopped in `SeedClient.close()`.
 *
 * Mirror of `sdks/rust/src/seed/health.rs`.
 */

/** Handle returned by {@link startHealthProbe}. */
interface HealthProbeHandle {
    /** Stop the probe and cancel any in-flight probe request. */
    stop(): void;
}
/** Configuration for the active health probe. */
interface HealthProbeOptions {
    /** Peer set to observe. */
    peers: PeerSet;
    /** Fetch function (same TLS policy as the owning client). */
    fetchFn: typeof fetch;
    /** Probe interval in milliseconds. MUST be > 0. */
    intervalMs: number;
    /** Per-probe timeout in milliseconds. Defaults to `intervalMs`. */
    probeTimeoutMs?: number;
    /**
     * Pairing-token getter — the probe hits `/api/v1/status` which is on
     * the WiFi-read allowlist and works unauthenticated, so the probe does
     * NOT require a token. Provided for symmetry with the request path.
     */
    tokenForPeer?: (peerUrl: string) => string | undefined;
}
/**
 * Start an active health probe. The interval is `unref`'d — it will NOT
 * keep the Node event loop alive, matching Rust's `tokio::spawn` +
 * `oneshot` shutdown semantics.
 *
 * In-flight probe requests are cancelled via `AbortSignal` when
 * {@link HealthProbeHandle.stop} is called, so clean shutdown is
 * deterministic.
 */
declare function startHealthProbe(opts: HealthProbeOptions): HealthProbeHandle;

/**
 * `ExplicitDiscovery` — trivial {@link DiscoveryProvider} that wraps a
 * caller-supplied list of endpoint URLs. Used internally so the rest of
 * the `SeedClient` pipeline can assume it always has a provider, not a
 * mixed `string | string[] | DiscoveryProvider` union.
 *
 * Explicit-list discovery is the Phase 1 required mode (ADR-0016a §D6);
 * mDNS is Phase 1.5 opt-in.
 */

/**
 * Wrap a single URL or an array of URLs into a {@link DiscoveryProvider}.
 * URLs are normalised via {@link normaliseBaseUrl} — trailing slashes
 * stripped, non-http(s) schemes rejected with {@link ConfigError}.
 */
declare class ExplicitDiscovery implements DiscoveryProvider {
    private readonly peers;
    constructor(endpoints: string | readonly string[]);
    discover(): Promise<DiscoveredPeer[]>;
}

/**
 * `TailscaleDiscovery` — opt-in Tailscale-native provider
 * (ADR-0016a §D6, closes OQ-11).
 *
 * Shells out to `tailscale status --json`, iterates the `Peer` map, and
 * returns the subset whose hostname matches a configurable prefix
 * (default `"cognitum-"`) or a caller-supplied predicate. Each kept
 * peer becomes a {@link DiscoveredPeer} with
 * `url = "https://<DNSName>:<port>"`.
 *
 * The seed does not advertise a `device_id` or `tls_fingerprint` via
 * the tailnet, so both stay `undefined`. Callers that also want
 * per-peer TLS pinning should combine this provider with `mdns.ts`
 * (via a fallback chain) or supply `tls.ca` on the client.
 *
 * No new dependency: shells out via `node:child_process.execFile`,
 * which is available on every supported Node runtime. The Tailscale
 * CLI binary is assumed to be on PATH; on Windows the command is
 * `tailscale.exe`, which `execFile` resolves automatically.
 */

/** Shape of one peer in `tailscale status --json`. */
interface TailscalePeer {
    /** Short hostname, e.g. `cognitum-61bc`. */
    HostName?: string;
    /** Fully-qualified DNS name, e.g. `cognitum-61bc.tail1234.ts.net.`. */
    DNSName?: string;
    /** Whether tailnet considers this peer reachable. */
    Online?: boolean;
}
/**
 * Minimal `execFile`-like signature. The real one lives in
 * `node:child_process`; exposed here as a parameter so tests can
 * stub it without fighting the module cache.
 */
type ExecFileFn = (file: string, args: readonly string[], cb: (err: (Error & {
    code?: string | number;
}) | null, stdout: string, stderr: string) => void) => void;
/** Options for {@link TailscaleDiscovery}. */
interface TailscaleDiscoveryOptions {
    /**
     * Host-name prefix used to filter peers when no `predicate` is given.
     * Defaults to `"cognitum-"` — matches the seed's auto-assigned
     * hostname pattern. Case-insensitive.
     */
    prefix?: string;
    /** TCP port to construct URLs with. Defaults to `8443`. */
    port?: number;
    /** URL scheme. `https` by default. */
    scheme?: "https" | "http";
    /**
     * Path to the `tailscale` binary. Defaults to `"tailscale"` (resolved
     * on PATH). On Windows Node resolves `"tailscale"` to `tailscale.exe`
     * automatically via PATHEXT.
     */
    command?: string;
    /**
     * Custom filter invoked for each tailnet peer. When supplied, it
     * replaces the prefix check entirely — the prefix is only consulted
     * when this is `undefined`.
     */
    predicate?: (peer: TailscalePeer) => boolean;
    /**
     * Inject a stub `execFile` for tests / callers that already wrap the
     * Tailscale CLI. Defaults to `require("node:child_process").execFile`.
     */
    execFile?: ExecFileFn;
}
/**
 * Opt-in Tailscale discovery provider. Returns peers from the local
 * tailnet whose hostname starts with the configured prefix.
 *
 * @example
 * ```ts
 * import { SeedClient } from "@cognitum/sdk/seed";
 * import { TailscaleDiscovery } from "@cognitum/sdk/seed/discovery/tailscale";
 *
 * const client = await SeedClient.create({
 *   endpoints: new TailscaleDiscovery({ prefix: "cognitum-" }),
 *   tls: { insecure: true }, // tailnet carries no cert fingerprint today
 * });
 * ```
 */
declare class TailscaleDiscovery implements DiscoveryProvider {
    private readonly prefix;
    private readonly port;
    private readonly scheme;
    private readonly command;
    private readonly predicate;
    private readonly execFile;
    constructor(opts?: TailscaleDiscoveryOptions);
    discover(): Promise<DiscoveredPeer[]>;
    private keep;
}

/** Base error class for all Cognitum SDK errors. */
declare class CognitumError extends Error {
    /** Machine-readable error code. */
    readonly code: string;
    /** HTTP status code, if applicable. */
    readonly statusCode?: number;
    constructor(message: string, code: string, statusCode?: number);
}
/** Thrown when the API key is missing or invalid (HTTP 401 / 403). */
declare class AuthError extends CognitumError {
    constructor(message?: string);
}
/** Thrown when the client is rate-limited (HTTP 429). */
declare class RateLimitError extends CognitumError {
    /** Milliseconds to wait before retrying, parsed from Retry-After header. */
    readonly retryAfterMs: number;
    constructor(retryAfterMs?: number, message?: string);
}
/** Thrown when a request fails validation (HTTP 400 / 422). */
declare class ValidationError extends CognitumError {
    constructor(message?: string);
}
/** Thrown when the requested resource does not exist (HTTP 404). */
declare class NotFoundError extends CognitumError {
    constructor(message?: string);
}
/** Thrown when a state conflict blocks the request (HTTP 409). */
declare class ConflictError extends CognitumError {
    constructor(message?: string);
}
/** Thrown when an endpoint or feature isn't implemented by the server (HTTP 501). */
declare class NotImplementedError extends CognitumError {
    /** Path or feature that is not implemented. */
    readonly endpoint?: string;
    constructor(endpoint?: string, message?: string);
}
/** Thrown when the server is temporarily unavailable (HTTP 503). */
declare class ServiceUnavailableError extends CognitumError {
    /** Milliseconds to wait before retrying, if the server hinted. */
    readonly retryAfterMs?: number;
    constructor(retryAfterMs?: number, message?: string);
}
/** Thrown when a low-level connect / socket / DNS failure prevents the request. */
declare class NetworkError extends CognitumError {
    constructor(message?: string, cause?: unknown);
}
/** Thrown when a request exceeds its timeout budget. */
declare class TimeoutError extends CognitumError {
    /** Which phase of the request timed out. */
    readonly phase: "connect" | "read" | "total";
    constructor(phase?: "connect" | "read" | "total", message?: string);
}
/** Thrown when the SDK cannot parse a response body. */
declare class ParseError extends CognitumError {
    readonly expected?: string;
    constructor(expected?: string, message?: string);
}
/** Thrown when the SDK is handed an invalid configuration. */
declare class ConfigError extends CognitumError {
    constructor(message?: string);
}
/**
 * Thrown when a caller requests a feature the seed does not (yet) implement.
 *
 * Today this surfaces when a per-call {@link CallOptions.consistency}
 * of `"strong"` is requested — ADR-0016a §D4 reserves the name for a
 * future Raft/Paxos write-quorum mode that seed firmware does not have.
 * The error is NOT retryable; no peer cycling, no backoff.
 */
declare class UnsupportedError extends CognitumError {
    /** Feature identifier (e.g. `"consistency=strong"`). */
    readonly feature: string;
    constructor(feature: string, message?: string);
}
/**
 * Thrown when a peer's TLS certificate fails fingerprint pinning.
 *
 * The Node SDK parses `fp=sha256:<hex>` from the seed's mDNS TXT record
 * (per `seed/src/cognitum-agent/src/discovery.rs:155-162`, FINDING-28)
 * and pins the TLS handshake to that certificate. If the peer presents a
 * cert whose SHA-256 does not match the advertised fingerprint (the
 * classic mDNS-spoofing signal), the handshake aborts with this error.
 *
 * This error is NOT retryable and does NOT fall back to `tls.insecure`
 * — a fingerprint mismatch is a hard trust failure. The failover state
 * machine surfaces it verbatim so callers see the spoofing signal.
 */
declare class TlsPinError extends CognitumError {
    /** Canonical peer URL that failed pinning. */
    readonly peerKey: string;
    /** Fingerprint the peer advertised (hex, lowercase, no colons). */
    readonly expectedFingerprint: string;
    /** SHA-256 of the cert the peer actually presented (hex, lowercase). */
    readonly actualFingerprint: string | undefined;
    constructor(peerKey: string, expectedFingerprint: string, actualFingerprint: string | undefined, message?: string);
}
/**
 * Thrown when the SDK aborts a request to protect the seed's trust-score
 * state (ADR-0007 §Trust-score protection, resolves OQ-9).
 *
 * The seed locks a client out after 3 consecutive failed auth attempts.
 * To prevent the caller from burning that budget (and triggering seed
 * lockdown), the SDK short-circuits on the third consecutive `AuthError`
 * against the same peer, raising this error instead of making the 4th
 * request that would tip the seed into lockdown.
 *
 * This error is NOT retryable — the failover state machine must NOT
 * cycle to another peer on it. The counter resets on a 2xx success
 * from the same peer, or via `SeedClient.resetTrustScore(peerKey?)`.
 */
declare class TrustScoreBlockedError extends CognitumError {
    /** Canonical URL key of the peer whose trust-score budget was exhausted. */
    readonly peerKey: string;
    /** Number of consecutive auth failures observed against `peerKey` (always 3). */
    readonly consecutiveFailures: 3;
    /**
     * `null` marker — intentionally not retryable. Exposed so tooling
     * that inspects `retryableAfter` on transient errors sees a definite
     * "do not retry" signal rather than `undefined` (which could be
     * mistaken for "retry immediately").
     */
    readonly retryableAfter: null;
    constructor(peerKey: string, message?: string);
}

export { AuthError, type CallConsistency, type CallOptions, type CallPrefer, type ClusterHealth, CognitumError, ConfigError, ConflictError, type CustodyEpoch, type CustodyResource, type DiscoveredPeer, type DiscoveryProvider, ExplicitDiscovery, type HealthProbeHandle, type IdentityResource, InMemoryTokenBook, type InlineTokenMap, type MeshPeerEntry, type MeshPeers, type MeshResource, type MeshStatus, NetworkError, NotFoundError, NotImplementedError, type OtaCheckResponse, type OtaConfig, type OtaResource, type PairCreateParams, type PairCreateResponse, type PairResource, type PairStatus, ParseError, type Peer, type PeerErrorClass, PeerSet, type PeerState, RateLimitError, type ResolvedSeedConfig, SecretString, type SeedAuthOptions, SeedClient, type SeedClientOptions, type SeedEndpoint, type SeedFailoverOptions, type SeedIdentity, type SeedRequestOptions, type SeedRouting, SeedSession, type SeedStatus, type SeedTimeoutOptions, type SeedTlsOptions, ServiceUnavailableError, type StatusResource, type StoreIngestItem, type StoreIngestParams, type StoreIngestResponse, type StoreQueryHit, type StoreQueryParams, type StoreQueryResponse, type StoreResource, type StoreStatus, type SwarmStatus, TailscaleDiscovery, type TailscaleDiscoveryOptions, TimeoutError, TlsPinError, type TokenBook, TrustScoreBlockedError, UnsupportedError, ValidationError, type WitnessChain, type WitnessEntry, type WitnessResource, normaliseBaseUrl, pairAll, startHealthProbe };
