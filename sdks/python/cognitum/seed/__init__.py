"""``cognitum.seed`` — seed-direct client (Phase 1, single-endpoint).

Public surface::

    from cognitum.seed import (
        SeedClient, AsyncSeedClient,
        SeedAuth, SeedTLS, SeedFailover,
        Status, Identity, PairStatus, PairCreateResponse,
        StoreStatus, StoreQueryResult, VectorUpsert,
        WitnessChain, Epoch, OtaConfig, OtaCheckNowResponse,
    )
"""

from __future__ import annotations

from cognitum.seed._async_client import AsyncSeedClient
from cognitum.seed._call_options import (
    CallOptions,
    Consistency,
    DISABLE_RETRY,
    Prefer,
)
from cognitum.seed._client import SeedClient, map_error
from cognitum.seed._config import (
    Endpoint,
    Routing,
    SeedAuth,
    SeedClientOptions,
    SeedFailover,
    SeedTLS,
    normalise_options,
)
from cognitum.seed._peers import Peer, PeerErrorClass, PeerSet, PeerState
from cognitum.seed._session import AsyncSeedSession, SeedSession
from cognitum.seed._token_book import (
    InMemoryTokenBook,
    SecretString,
    TokenBook,
    pair_all,
)
from cognitum.seed._errors import (
    ApiError,
    AuthError,
    AuthReason,
    CognitumError,
    ConfigError,
    ConflictError,
    NetworkError,
    NotFoundError,
    NotImplementedError,  # noqa: A004
    ParseError,
    RateLimitError,
    ServiceUnavailableError,
    TimeoutError,  # noqa: A004
    TrustScoreBlockedError,
    UnsupportedError,
    ValidationError,
)
from cognitum.seed._models import (
    ClusterHealth,
    Epoch,
    Identity,
    MeshPeer,
    MeshPeers,
    MeshStatus,
    OtaCheckNowResponse,
    OtaConfig,
    PairCreateResponse,
    PairStatus,
    QueryMatch,
    Status,
    StoreIngestRequest,
    StoreQueryResult,
    StoreStatus,
    SwarmStatus,
    VectorUpsert,
    WitnessChain,
)
from cognitum.seed._retry import (
    RetryPolicy,
    compute_delay,
    compute_delay_ms,
    is_retriable,
    parse_retry_after,
)
from cognitum.seed._transport import SeedPinnedVerifier

__all__ = [
    # Clients
    "SeedClient",
    "AsyncSeedClient",
    "SeedSession",
    "AsyncSeedSession",
    # Config
    "Endpoint",
    "Routing",
    "SeedAuth",
    "SeedClientOptions",
    "SeedFailover",
    "SeedTLS",
    "normalise_options",
    # Mesh (Phase 1.5)
    "Peer",
    "PeerErrorClass",
    "PeerSet",
    "PeerState",
    "TokenBook",
    "InMemoryTokenBook",
    "SecretString",
    "pair_all",
    # Per-call knobs (Phase 2)
    "CallOptions",
    "Consistency",
    "DISABLE_RETRY",
    "Prefer",
    # TLS
    "SeedPinnedVerifier",
    # Retry helpers
    "RetryPolicy",
    "compute_delay",
    "compute_delay_ms",
    "is_retriable",
    "parse_retry_after",
    # Errors
    "ApiError",
    "AuthError",
    "AuthReason",
    "CognitumError",
    "ConfigError",
    "ConflictError",
    "NetworkError",
    "NotFoundError",
    "NotImplementedError",
    "ParseError",
    "RateLimitError",
    "ServiceUnavailableError",
    "TimeoutError",
    "TrustScoreBlockedError",
    "UnsupportedError",
    "ValidationError",
    # Models
    "ClusterHealth",
    "Epoch",
    "Identity",
    "MeshPeer",
    "MeshPeers",
    "MeshStatus",
    "OtaCheckNowResponse",
    "OtaConfig",
    "PairCreateResponse",
    "PairStatus",
    "QueryMatch",
    "Status",
    "StoreIngestRequest",
    "StoreQueryResult",
    "StoreStatus",
    "SwarmStatus",
    "VectorUpsert",
    "WitnessChain",
    # Diagnostic
    "map_error",
]
