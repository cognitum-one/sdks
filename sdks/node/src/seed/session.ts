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

import type { SeedClient } from "./client.js";
import type { CallOptions } from "./callOptions.js";
import { makeCustodyResource, type CustodyResource } from "./resources/custody.js";
import {
  makeIdentityResource,
  type IdentityResource,
} from "./resources/identity.js";
import { makeMeshResource, type MeshResource } from "./resources/mesh.js";
import { makeOtaResource, type OtaResource } from "./resources/ota.js";
import { makePairResource, type PairResource } from "./resources/pair.js";
import { makeStatusResource, type StatusResource } from "./resources/status.js";
import { makeStoreResource, type StoreResource } from "./resources/store.js";
import {
  makeWitnessResource,
  type WitnessResource,
} from "./resources/witness.js";

/**
 * One-peer session. Pins reads + writes to `pinnedPeer` via an
 * implementation-level request hook on the owning {@link SeedClient}.
 */
export class SeedSession {
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
  constructor(client: SeedClient, pinnedPeer: string) {
    this.pinnedPeer = pinnedPeer;

    // Bind every resource to a request function that forces the pinned
    // peer via the `pinnedPeerKey` option. The request pipeline honours
    // the pin when healthy and cycles only if the peer hard-fails. The
    // spread of `opts` forwards any per-call `CallOptions` unchanged so
    // callers can still override `peer:` / `prefer:` / `consistency:`
    // etc. on individual session calls.
    // Type matches the per-resource RequestFn signature. CallOptions covers
    // all per-call knobs the resources may pass (peer/prefer/consistency/etc.);
    // idempotent is a transport hint added by the resource layer.
    const req: <T>(
      method: string,
      path: string,
      opts?: CallOptions & { idempotent?: boolean },
    ) => Promise<T> = (method, path, opts) =>
      client.request(method, path, {
        ...(opts ?? {}),
        pinnedPeerKey: pinnedPeer,
      });

    this.status = makeStatusResource(req);
    this.identity = makeIdentityResource(req);
    this.pair = makePairResource(req);
    this.witness = makeWitnessResource(req);
    this.custody = makeCustodyResource(req);
    this.store = makeStoreResource(req);
    this.ota = makeOtaResource(req);
    this.mesh = makeMeshResource(req);
  }
}
