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
    ValidationError,
)
from cognitum.seed._models import (
    Epoch,
    Identity,
    OtaCheckNowResponse,
    OtaConfig,
    PairCreateResponse,
    PairEntry,
    PairStatus,
    QueryMatch,
    Status,
    StoreIngestRequest,
    StoreQueryResult,
    StoreStatus,
    VectorUpsert,
    WitnessChain,
    WitnessEntry,
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
    # Config
    "Endpoint",
    "Routing",
    "SeedAuth",
    "SeedClientOptions",
    "SeedFailover",
    "SeedTLS",
    "normalise_options",
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
    "ValidationError",
    # Models
    "Epoch",
    "Identity",
    "OtaCheckNowResponse",
    "OtaConfig",
    "PairCreateResponse",
    "PairEntry",
    "PairStatus",
    "QueryMatch",
    "Status",
    "StoreIngestRequest",
    "StoreQueryResult",
    "StoreStatus",
    "VectorUpsert",
    "WitnessChain",
    "WitnessEntry",
    # Diagnostic
    "map_error",
]
