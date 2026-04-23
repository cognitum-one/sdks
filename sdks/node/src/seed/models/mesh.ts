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
export interface MeshPeerEntry extends Record<string, unknown> {
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
export interface MeshStatus extends Record<string, unknown> {
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
export interface MeshPeers extends Record<string, unknown> {
  count?: number;
  discovery_active?: boolean;
  peers?: MeshPeerEntry[];
}

/** `GET /api/v1/swarm/status` — swarm coordination state. */
export interface SwarmStatus extends Record<string, unknown> {
  device_id?: string;
  discovery_active?: boolean;
  epoch?: number;
  peer_count?: number;
  total_vectors?: number;
  uptime_secs?: number;
}

/** `GET /api/v1/cluster/health` — cluster-level aggregate. */
export interface ClusterHealth extends Record<string, unknown> {
  auto_sync_interval_secs?: number;
  cluster_enabled?: boolean;
  discovery_active?: boolean;
  last_sync_attempt?: number;
  peer_count?: number;
  peers?: MeshPeerEntry[];
}
