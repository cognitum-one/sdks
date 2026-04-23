"""Micro-benchmark for :meth:`SeedClient.status`.

Compares the SDK hot path against a raw ``httpx.Client.get`` against a
local mock transport. The goal per ADR-0005 is <1 ms p50 overhead.

Running:

    # With pytest-benchmark installed (preferred):
    pip install pytest-benchmark
    pytest tests/seed/bench/test_bench_status.py --benchmark-only

    # Without pytest-benchmark, this module also exposes a CLI:
    python tests/seed/bench/test_bench_status.py

TODO: promote ``pytest-benchmark`` to ``[project.optional-dependencies].dev``
when this bench is adopted in CI. It's kept optional so the main dev-deps
set stays lean.
"""

from __future__ import annotations

import time
from typing import Callable

import httpx
import pytest

from cognitum.seed import SeedClient


_STATUS_JSON = {
    "device_id": "bench-0",
    "uptime_secs": 1,
    "epoch": 0,
    "total_vectors": 0,
    "deleted_vectors": 0,
    "file_size_bytes": 0,
    "dimension": 8,
    "paired": False,
    "roles": [],
}


def _mock_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json=_STATUS_JSON)


def _build_seed_client() -> SeedClient:
    client = SeedClient(
        "https://localhost:18443",
        tls=None,  # System trust; MockTransport intercepts before TLS anyway.
    )
    # Swap in MockTransport so we avoid a live socket / real TLS handshake.
    client._transport._client = httpx.Client(  # type: ignore[attr-defined]
        base_url="https://localhost:18443",
        transport=httpx.MockTransport(_mock_handler),
    )
    return client


def _build_raw_client() -> httpx.Client:
    return httpx.Client(
        base_url="https://localhost:18443",
        transport=httpx.MockTransport(_mock_handler),
    )


try:
    import pytest_benchmark  # type: ignore  # noqa: F401
    HAS_BENCH = True
except ImportError:  # pragma: no cover — optional dep
    HAS_BENCH = False


@pytest.mark.skipif(not HAS_BENCH, reason="pytest-benchmark not installed")
def test_bench_seed_status(benchmark) -> None:  # type: ignore[no-untyped-def]
    client = _build_seed_client()
    try:
        benchmark(lambda: client.status())
    finally:
        client.close()


@pytest.mark.skipif(not HAS_BENCH, reason="pytest-benchmark not installed")
def test_bench_raw_get(benchmark) -> None:  # type: ignore[no-untyped-def]
    client = _build_raw_client()
    try:
        benchmark(lambda: client.get("/api/v1/status").json())
    finally:
        client.close()


def _measure(label: str, iters: int, fn: Callable[[], None]) -> float:
    # warm up
    for _ in range(50):
        fn()
    samples = []
    for _ in range(iters):
        t0 = time.perf_counter()
        fn()
        samples.append(time.perf_counter() - t0)
    samples.sort()
    p50 = samples[iters // 2] * 1000
    p95 = samples[int(iters * 0.95)] * 1000
    mean = (sum(samples) / iters) * 1000
    print(f"{label:30s}  mean={mean:.3f}ms  p50={p50:.3f}ms  p95={p95:.3f}ms")
    return p50


def main() -> None:
    iters = 1000
    raw = _build_raw_client()
    sdk = _build_seed_client()
    try:
        raw_p50 = _measure("raw httpx GET", iters, lambda: raw.get("/api/v1/status").json())
        sdk_p50 = _measure("SeedClient.status()", iters, lambda: sdk.status())
        print(f"\nSDK overhead (p50 delta): {sdk_p50 - raw_p50:.3f} ms")
        if sdk_p50 - raw_p50 < 1.0:
            print("PASS: <1 ms p50 overhead")
        else:
            print("WARN: >=1 ms p50 overhead")
    finally:
        raw.close()
        sdk.close()


if __name__ == "__main__":
    main()
