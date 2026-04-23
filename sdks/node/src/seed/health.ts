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

import type { PeerErrorClass, PeerSet } from "./peers.js";

/** Handle returned by {@link startHealthProbe}. */
export interface HealthProbeHandle {
  /** Stop the probe and cancel any in-flight probe request. */
  stop(): void;
}

/** Configuration for the active health probe. */
export interface HealthProbeOptions {
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
export function startHealthProbe(opts: HealthProbeOptions): HealthProbeHandle {
  const { peers, fetchFn, intervalMs } = opts;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError(
      `startHealthProbe: intervalMs must be > 0 (got ${intervalMs})`,
    );
  }

  const probeTimeout = opts.probeTimeoutMs ?? intervalMs;
  let stopped = false;
  const controllers: Set<AbortController> = new Set();

  const tick = async (): Promise<void> => {
    if (stopped) return;
    // Snapshot the peer table so we don't walk a mutating list.
    const snapshot = peers.snapshot();
    await Promise.all(
      snapshot.map(async (p) => {
        if (stopped) return;
        const ctrl = new AbortController();
        controllers.add(ctrl);
        const timer = setTimeout(() => ctrl.abort(), probeTimeout);
        try {
          const headers: Record<string, string> = {
            Accept: "application/json",
          };
          const tok = opts.tokenForPeer?.(p.key);
          if (tok) headers["X-Pairing-Token"] = tok;

          const res = await fetchFn(`${p.baseUrl}/api/v1/status`, {
            method: "GET",
            headers,
            signal: ctrl.signal,
          });
          if (res.ok) {
            peers.markSuccess(p.key, probeTimeout);
          } else {
            const cls = classifyProbeStatus(res.status);
            if (cls) peers.markFailure(p.key, cls);
          }
          // Drain the body so the underlying socket can be reused — for
          // `undici` dispatchers, unread bodies hold the connection.
          try {
            await res.text();
          } catch {
            /* noop */
          }
        } catch (err) {
          if (stopped) return;
          const cls = classifyProbeError(err);
          peers.markFailure(p.key, cls);
        } finally {
          clearTimeout(timer);
          controllers.delete(ctrl);
        }
      }),
    );
  };

  const interval = setInterval(() => {
    void tick();
  }, intervalMs);
  // `unref` so the probe never blocks process exit. Available on Node's
  // Timeout; the `typeof` guard keeps this file safe in non-Node runtimes.
  if (typeof (interval as { unref?: () => void }).unref === "function") {
    (interval as { unref: () => void }).unref();
  }

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      for (const c of controllers) {
        try {
          c.abort();
        } catch {
          /* noop */
        }
      }
      controllers.clear();
    },
  };
}

function classifyProbeStatus(status: number): PeerErrorClass | undefined {
  if (status === 503) return "serviceUnavailable";
  if (status === 500 || status === 502 || status === 504) return "server5xx";
  // 4xx on a probe usually means the peer is up but refusing us (no
  // auth, rate-limited). Don't degrade the peer for those.
  return undefined;
}

function classifyProbeError(err: unknown): PeerErrorClass {
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return "timeout";
    }
  }
  return "network";
}
