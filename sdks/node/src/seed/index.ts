/**
 * `@cognitum/sdk/seed` — Phase 1.5 seed-direct entry point.
 *
 * Re-exports the public surface; subpath consumers should import from
 * this module rather than reaching into `src/seed/client.js` directly.
 */

export { SeedClient, type SeedRequestOptions } from "./client.js";
export { SeedSession } from "./session.js";
export type {
  SeedClientOptions,
  SeedEndpoint,
  SeedAuthOptions,
  SeedTlsOptions,
  SeedRouting,
  SeedFailoverOptions,
  SeedTimeoutOptions,
  InlineTokenMap,
  ResolvedSeedConfig,
} from "./config.js";
export {
  PeerSet,
  normaliseBaseUrl,
  type Peer,
  type PeerState,
  type PeerErrorClass,
} from "./peers.js";
export {
  InMemoryTokenBook,
  SecretString,
  pairAll,
  type TokenBook,
} from "./tokenBook.js";
export { startHealthProbe, type HealthProbeHandle } from "./health.js";

export type { StatusResource, SeedStatus } from "./resources/status.js";
export type { IdentityResource, SeedIdentity } from "./resources/identity.js";
export type {
  PairResource,
  PairStatus,
  PairCreateParams,
  PairCreateResponse,
} from "./resources/pair.js";
export type {
  WitnessResource,
  WitnessChain,
  WitnessEntry,
} from "./resources/witness.js";
export type { CustodyResource, CustodyEpoch } from "./resources/custody.js";
export type {
  StoreResource,
  StoreStatus,
  StoreQueryParams,
  StoreQueryResponse,
  StoreQueryHit,
  StoreIngestParams,
  StoreIngestItem,
  StoreIngestResponse,
} from "./resources/store.js";
export type { OtaResource, OtaConfig, OtaCheckResponse } from "./resources/ota.js";

// Cross-SDK error taxonomy — seed callers catch on these.
export {
  CognitumError,
  AuthError,
  RateLimitError,
  ValidationError,
  NotFoundError,
  ConflictError,
  NotImplementedError,
  ServiceUnavailableError,
  NetworkError,
  TimeoutError,
  ParseError,
  ConfigError,
  TrustScoreBlockedError,
} from "../errors.js";
