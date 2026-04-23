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
 * `MdnsDiscovery` — opt-in mDNS provider (ADR-0016a §D6 Phase 1.5).
 *
 * Imports `multicast-dns` via the seed's service type
 * `_cognitum._tcp.local` and returns the TXT records emitted by
 * `seed/src/cognitum-agent/src/discovery.rs:137-180` as
 * {@link DiscoveredPeer}s.
 *
 * The wire library is declared as a **peerDependency** so the core
 * `@cognitum/sdk` install stays lean — callers who want mDNS opt into
 * the dep by importing this file via the subpath
 * `@cognitum/sdk/seed/discovery/mdns`.
 *
 * Phase 3 punted items (tracked in `docs/adr/0015c-...` §"Phase 3 —
 * mDNS discovery"):
 *
 * - PTR → SRV → A/AAAA chain lookup. Today we trust the TXT-record host
 *   hint plus a fallback to the seed's default `.local` hostname.
 * - Full `fp=` (cert fingerprint) propagation. Parsed but not yet
 *   surfaced on `DiscoveredPeer` — ADR-040 FINDING-28 wants it wired
 *   into the TLS handshake path. Deferred to the mDNS-spoofing track.
 */

/**
 * Structural shim for the `multicast-dns` module. Declared here so the
 * SDK can compile without the dep installed — `peerDependencies`
 * install the real module at the caller's discretion.
 */
interface MdnsInstance {
    query(name: string | {
        questions: Array<{
            name: string;
            type: string;
        }>;
    }, type?: string): void;
    on(event: "response", cb: (packet: MdnsPacket) => void): void;
    destroy(cb?: () => void): void;
}
interface MdnsPacket {
    answers?: MdnsAnswer[];
    additionals?: MdnsAnswer[];
}
interface MdnsAnswer {
    name: string;
    type: string;
    data: unknown;
}
/** Factory signature exported by `multicast-dns`. */
type MdnsFactory = (opts?: {
    multicast?: boolean;
    interface?: string;
    port?: number;
    loopback?: boolean;
}) => MdnsInstance;
/** Options for {@link MdnsDiscovery}. */
interface MdnsDiscoveryOptions {
    /**
     * DNS-SD service type. Defaults to the seed's advertised
     * `_cognitum._tcp.local` per `seed/src/cognitum-agent/src/discovery.rs:99`.
     */
    serviceType?: string;
    /**
     * Collection window in ms. Responses arriving after this fire-and-
     * forget window are dropped. Default 500ms — long enough to catch
     * seeds on the same LAN, short enough that `client.rediscover()` is
     * snappy. Must be a positive number.
     */
    timeoutMs?: number;
    /**
     * Default TCP port to construct URLs with when the TXT record omits
     * `port=`. Defaults to 8443 (seed HTTPS).
     */
    defaultPort?: number;
    /**
     * TLS scheme for constructed URLs. `https` by default; set to `http`
     * only for mesh test harnesses.
     */
    scheme?: "https" | "http";
    /**
     * Inject the `multicast-dns` factory (tests + advanced callers). When
     * omitted, {@link MdnsDiscovery.discover} dynamically imports
     * `multicast-dns` the first time it is invoked. The dynamic import
     * keeps the dep optional at install time.
     */
    mdnsFactory?: MdnsFactory;
}
/**
 * Opt-in mDNS discovery provider. Returns peers whose TXT records
 * answer a PTR query for the configured service type.
 *
 * @example
 * ```ts
 * import { SeedClient } from "@cognitum/sdk/seed";
 * import { MdnsDiscovery } from "@cognitum/sdk/seed/discovery/mdns";
 *
 * const client = new SeedClient({
 *   endpoints: new MdnsDiscovery(),
 *   tls: { insecure: true }, // dev only
 * });
 * ```
 */
declare class MdnsDiscovery implements DiscoveryProvider {
    private readonly serviceType;
    private readonly timeoutMs;
    private readonly defaultPort;
    private readonly scheme;
    private readonly mdnsFactory;
    /** Lazily instantiated mDNS wire handle — reused across `discover()` calls. */
    private instance;
    constructor(opts?: MdnsDiscoveryOptions);
    /**
     * Convenience constructor matching the ADR example surface —
     * `MdnsDiscovery.default()` reads as "use the seed's published
     * defaults" at call-sites.
     */
    static default(): MdnsDiscovery;
    discover(): Promise<DiscoveredPeer[]>;
    close(): Promise<void>;
    private ensureInstance;
    private matchesService;
    private peerFromTxt;
}

export { MdnsDiscovery, type MdnsDiscoveryOptions };
