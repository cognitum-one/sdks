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
 *
 * `fp=` (cert fingerprint) pinning — ADR-0015c Phase 3 §fp= cert
 * pinning (2026-04-23) — is now parsed into
 * {@link DiscoveredPeer.tlsFingerprint} and wired into the per-peer
 * TLS handshake by `src/seed/transport.ts`. A mismatch throws
 * {@link TlsPinError}; see that class' docstring for semantics.
 */

import type { DiscoveryProvider, DiscoveredPeer } from "./types.js";
import { ConfigError } from "../../errors.js";

// Node built-ins used below. Declared rather than imported so the
// `tsup --dts` pass — which runs without `@types/node` in lib — still
// emits types cleanly. Mirrors the pattern used across `src/seed/*.ts`.
declare const TextDecoder: {
  new (encoding?: string): { decode(input?: Uint8Array): string };
};
declare function setTimeout(cb: () => void, ms?: number): unknown;

/**
 * Structural shim for the `multicast-dns` module. Declared here so the
 * SDK can compile without the dep installed — `peerDependencies`
 * install the real module at the caller's discretion.
 */
interface MdnsInstance {
  query(
    name: string | { questions: Array<{ name: string; type: string }> },
    type?: string,
  ): void;
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
export interface MdnsDiscoveryOptions {
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

const DEFAULT_SERVICE_TYPE = "_cognitum._tcp.local";
const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_PORT = 8443;

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
export class MdnsDiscovery implements DiscoveryProvider {
  private readonly serviceType: string;
  private readonly timeoutMs: number;
  private readonly defaultPort: number;
  private readonly scheme: "https" | "http";
  private readonly mdnsFactory: MdnsFactory | undefined;
  /** Lazily instantiated mDNS wire handle — reused across `discover()` calls. */
  private instance: MdnsInstance | undefined;

  constructor(opts: MdnsDiscoveryOptions = {}) {
    this.serviceType = opts.serviceType ?? DEFAULT_SERVICE_TYPE;
    const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new ConfigError(
        `MdnsDiscovery.timeoutMs must be a positive number (got ${timeout})`,
      );
    }
    this.timeoutMs = timeout;
    this.defaultPort = opts.defaultPort ?? DEFAULT_PORT;
    this.scheme = opts.scheme ?? "https";
    this.mdnsFactory = opts.mdnsFactory;
  }

  /**
   * Convenience constructor matching the ADR example surface —
   * `MdnsDiscovery.default()` reads as "use the seed's published
   * defaults" at call-sites.
   */
  static default(): MdnsDiscovery {
    return new MdnsDiscovery();
  }

  async discover(): Promise<DiscoveredPeer[]> {
    const mdns = await this.ensureInstance();
    const seen = new Map<string, DiscoveredPeer>();

    const collector = (packet: MdnsPacket): void => {
      const records = [
        ...(packet.answers ?? []),
        ...(packet.additionals ?? []),
      ];
      for (const rec of records) {
        if (rec.type !== "TXT") continue;
        if (!this.matchesService(rec.name)) continue;
        const parsed = parseTxtRecord(rec.data);
        if (!parsed) continue;
        const peer = this.peerFromTxt(parsed, rec.name);
        if (peer && !seen.has(peer.url)) {
          seen.set(peer.url, peer);
        }
      }
    };

    mdns.on("response", collector);
    mdns.query({
      questions: [{ name: this.serviceType, type: "PTR" }],
    });

    await sleep(this.timeoutMs);

    // `multicast-dns` lacks a typed `off`; best-effort detach to keep
    // the listener list small across repeated `discover()` calls.
    const off = (mdns as unknown as {
      removeListener?: (e: string, cb: (p: MdnsPacket) => void) => void;
    }).removeListener;
    off?.call(mdns, "response", collector);

    return Array.from(seen.values());
  }

  async close(): Promise<void> {
    const inst = this.instance;
    this.instance = undefined;
    if (!inst) return;
    await new Promise<void>((resolve) => {
      try {
        inst.destroy(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  // ------------------------------------------------------------------ //
  // internals                                                           //
  // ------------------------------------------------------------------ //

  private async ensureInstance(): Promise<MdnsInstance> {
    if (this.instance) return this.instance;
    const factory = this.mdnsFactory ?? (await loadMdnsFactory());
    this.instance = factory();
    return this.instance;
  }

  private matchesService(recordName: string): boolean {
    // TXT records may be attached to either `_cognitum._tcp.local` or
    // a per-instance name like `cognitum-61bc._cognitum._tcp.local`.
    return (
      recordName === this.serviceType ||
      recordName.endsWith(`.${this.serviceType}`)
    );
  }

  private peerFromTxt(
    txt: Record<string, string>,
    recordName: string,
  ): DiscoveredPeer | undefined {
    const port =
      Number.parseInt(txt.port ?? "", 10) || this.defaultPort;
    const host = hostFromRecordName(recordName) ?? txt.host;
    if (!host) return undefined;
    const url = `${this.scheme}://${host}:${port}`;
    const tlsFingerprint = parseFingerprint(txt.fp);
    const peer: DiscoveredPeer = {
      url,
      deviceId: txt.id,
    };
    if (tlsFingerprint !== undefined) {
      peer.tlsFingerprint = tlsFingerprint;
    }
    return peer;
  }
}

/**
 * Parse a TXT-record `fp=` value into the canonical hex-only form used
 * by the transport layer's pinning check.
 *
 * Accepts:
 *  - `sha256:<hex>` (the form documented in ADR-040 FINDING-28)
 *  - bare `<hex>` (the form the seed emits today, per
 *    `seed/src/cognitum-agent/src/discovery.rs:162`)
 *
 * Normalisation: strip any `sha256:` prefix (case-insensitive), strip
 * colons (some DNS-SD responders format fingerprints as
 * `aa:bb:cc:...`), lowercase. A string that contains any non-hex
 * character after normalisation is rejected — returning `undefined`
 * rather than throwing so a malformed TXT doesn't tank the whole
 * `discover()` batch.
 *
 * Exported for unit testing (`tests/seed/unit/discovery-mdns-fp.test.ts`).
 */
export function parseFingerprint(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return undefined;
  let s = raw.trim();
  if (s.length === 0) return undefined;
  // Strip `sha256:` / `SHA256:` prefix if present.
  const colonIdx = s.indexOf(":");
  if (colonIdx > 0 && colonIdx <= 7) {
    const prefix = s.slice(0, colonIdx).toLowerCase();
    if (prefix === "sha256" || prefix === "sha-256") {
      s = s.slice(colonIdx + 1);
    }
  }
  // Strip any remaining colons (legacy `aa:bb:cc` style).
  s = s.replace(/:/g, "").toLowerCase();
  if (s.length === 0) return undefined;
  if (s.length % 2 !== 0) return undefined;
  if (!/^[0-9a-f]+$/.test(s)) return undefined;
  return s;
}

/**
 * Parse a TXT record's `data` field into a key=value map. `multicast-dns`
 * exposes the data as `Buffer | Buffer[]` (one Buffer per entry).
 */
function parseTxtRecord(data: unknown): Record<string, string> | undefined {
  const entries: unknown[] = Array.isArray(data) ? data : [data];
  const out: Record<string, string> = {};
  let any = false;
  const decoder = new TextDecoder("utf-8");
  for (const e of entries) {
    let s: string | undefined;
    if (typeof e === "string") {
      s = e;
    } else if (e instanceof Uint8Array) {
      s = decoder.decode(e);
    } else if (
      e !== null &&
      typeof e === "object" &&
      "toString" in e &&
      typeof (e as { toString: unknown }).toString === "function"
    ) {
      s = String(e);
    }
    if (!s) continue;
    const idx = s.indexOf("=");
    if (idx <= 0) continue;
    const key = s.slice(0, idx).trim().toLowerCase();
    const val = s.slice(idx + 1);
    if (!key) continue;
    out[key] = val;
    any = true;
  }
  return any ? out : undefined;
}

/**
 * Extract the instance host from a fully-qualified DNS-SD record name
 * like `cognitum-61bc._cognitum._tcp.local` → `cognitum-61bc.local`.
 * Returns `undefined` when the record name is the bare service type.
 */
function hostFromRecordName(recordName: string): string | undefined {
  // Strip the `._cognitum._tcp` middle labels and re-append `.local`.
  const m = recordName.match(/^([^.]+)\._[^.]+\._tcp\.(.+)$/);
  if (!m) return undefined;
  return `${m[1]}.${m[2]}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Dynamically import `multicast-dns`. Surfaces a typed {@link ConfigError}
 * when the dep isn't installed so the failure mode is clearly a
 * missing-peer-dep rather than an opaque module resolution error.
 */
async function loadMdnsFactory(): Promise<MdnsFactory> {
  try {
    // Indirected through a string var so tsc doesn't try to resolve the
    // optional peer dep at type-check time. `multicast-dns` is declared
    // as a peerDependency — real callers who opt in will install it.
    const spec = "multicast-dns";
    const mod = (await import(spec)) as unknown as
      | { default: MdnsFactory }
      | MdnsFactory;
    const factory = (mod as { default?: MdnsFactory }).default ?? (mod as MdnsFactory);
    if (typeof factory !== "function") {
      throw new Error("multicast-dns module did not export a factory");
    }
    return factory;
  } catch (err) {
    throw new ConfigError(
      `mDNS discovery requires the optional 'multicast-dns' dependency. ` +
        `Install it: npm install multicast-dns (original error: ${
          err instanceof Error ? err.message : String(err)
        })`,
    );
  }
}
