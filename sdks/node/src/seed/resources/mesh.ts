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

import type { CallOptions } from "../callOptions.js";
import type {
  ClusterHealth,
  MeshPeers,
  MeshStatus,
  SwarmStatus,
} from "../models/mesh.js";

/**
 * Per-call request signature accepted by every resource. Mirrors the
 * shared shape in `SeedClient.request` — kept narrow here so mesh stays
 * decoupled from `client.ts` imports.
 */
type RequestFn = <T>(
  method: string,
  path: string,
  opts?: CallOptions & {
    idempotent?: boolean;
  },
) => Promise<T>;

export interface MeshResource {
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

/** Build the mesh observability resource bound to `request`. */
export function makeMeshResource(request: RequestFn): MeshResource {
  return {
    status: (opts) =>
      request<MeshStatus>("GET", "/api/v1/network/mesh/status", {
        idempotent: true,
        ...(opts ?? {}),
      }),

    peers: (opts) =>
      request<MeshPeers>("GET", "/api/v1/peers", {
        idempotent: true,
        ...(opts ?? {}),
      }),

    swarmStatus: (opts) =>
      request<SwarmStatus>("GET", "/api/v1/swarm/status", {
        idempotent: true,
        ...(opts ?? {}),
      }),

    clusterHealth: (opts) =>
      request<ClusterHealth>("GET", "/api/v1/cluster/health", {
        idempotent: true,
        ...(opts ?? {}),
      }),
  };
}
