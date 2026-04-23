/**
 * MeshResource unit tests — ADR-0016a §D8 Phase 1 surface addendum.
 *
 * Four read endpoints bound to the seed's mesh observability surface.
 * Each test verifies the factory routes to the correct path with the
 * correct method and marks the call as idempotent (so the retry loop
 * treats read-timeouts as retryable).
 */

import { describe, it, expect, vi } from "vitest";
import { makeMeshResource } from "../../../src/seed/resources/mesh.js";

describe("mesh resource (ADR-0016a §D8)", () => {
  it("status() GETs /api/v1/network/mesh/status and returns the body", async () => {
    const body = {
      ap_active: true,
      auto_mesh: false,
      connected_to_seed: false,
      device_id: "ad7d7e7b-56e7-4e03-b078-939209858144",
      has_mesh_password: false,
      peer_count: 0,
      peers: [],
    };
    const request = vi.fn(async () => body);
    const mesh = makeMeshResource(request as never);

    const got = await mesh.status();

    expect(request).toHaveBeenCalledTimes(1);
    const [method, path, opts] = request.mock.calls[0];
    expect(method).toBe("GET");
    expect(path).toBe("/api/v1/network/mesh/status");
    expect(opts).toMatchObject({ idempotent: true });
    expect(got).toEqual(body);
  });

  it("peers() GETs /api/v1/peers with { count, discovery_active, peers }", async () => {
    const body = { count: 0, discovery_active: true, peers: [] };
    const request = vi.fn(async () => body);
    const mesh = makeMeshResource(request as never);

    const got = await mesh.peers();

    const [method, path, opts] = request.mock.calls[0];
    expect(method).toBe("GET");
    expect(path).toBe("/api/v1/peers");
    expect(opts).toMatchObject({ idempotent: true });
    expect(got.discovery_active).toBe(true);
  });

  it("swarmStatus() GETs /api/v1/swarm/status and returns epoch + device_id", async () => {
    const body = {
      device_id: "ad7d7e7b-56e7-4e03-b078-939209858144",
      discovery_active: true,
      epoch: 20564,
      peer_count: 0,
      total_vectors: 8460,
      uptime_secs: 23000,
    };
    const request = vi.fn(async () => body);
    const mesh = makeMeshResource(request as never);

    const got = await mesh.swarmStatus();

    const [method, path] = request.mock.calls[0];
    expect(method).toBe("GET");
    expect(path).toBe("/api/v1/swarm/status");
    expect(got.epoch).toBe(20564);
    expect(got.total_vectors).toBe(8460);
  });

  it("clusterHealth() GETs /api/v1/cluster/health and returns cluster_enabled", async () => {
    const body = {
      auto_sync_interval_secs: 60,
      cluster_enabled: true,
      discovery_active: true,
      last_sync_attempt: 1776906537,
      peer_count: 0,
      peers: [],
    };
    const request = vi.fn(async () => body);
    const mesh = makeMeshResource(request as never);

    const got = await mesh.clusterHealth();

    const [method, path, opts] = request.mock.calls[0];
    expect(method).toBe("GET");
    expect(path).toBe("/api/v1/cluster/health");
    expect(opts).toMatchObject({ idempotent: true });
    expect(got.cluster_enabled).toBe(true);
  });

  it("forwards per-call options to the request function", async () => {
    const request = vi.fn(async () => ({}));
    const mesh = makeMeshResource(request as never);

    await mesh.status({ prefer: "local-first", timeoutMs: 2500 });

    const [, , opts] = request.mock.calls[0];
    expect(opts).toMatchObject({
      idempotent: true,
      prefer: "local-first",
      timeoutMs: 2500,
    });
  });
});
