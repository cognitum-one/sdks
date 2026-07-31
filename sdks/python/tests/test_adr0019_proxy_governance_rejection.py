"""ADR-0019 "Compliance and verification" #7 (issue #74): proxy governance
rejection test.

> A proxy test proves an unsupported Meta LLM governance call is rejected
> locally and never reaches ``/v1/*`` on the proxy fixture.

ADR-0019 §D7: "Meta LLM governance methods are never sent to Meta Proxy."
``MetaProxyClient``'s public surface (``cognitum/meta_proxy/client.py``) is
exactly ``status``, ``capabilities``, ``chat.completions``,
``chat.completions_stream``, and ``preview.sponsored.chat.completions`` --
a strict subset of ``MetaLlmClient``'s surface, which additionally exposes
governance/account operations (``models``, ``whoami``, ``usage``, ``ready``)
plus names the Context section mentions but that exist nowhere as callable
methods yet (``batches``, ``pods``).

There is no generic "forward any operation" escape hatch on
``MetaProxyClient`` -- governance calls are rejected locally in the
strongest possible way: the method does not exist, so a caller cannot even
construct the wire request. This is proven two ways: reflectively (the
attribute is absent), and behaviorally (calling it anyway raises
``AttributeError`` synchronously, and a ``httpx.MockTransport`` handler
that raises on any request proves the fixture never saw it -- while a
real, supported call DOES reach the fixture, ruling out a false-negative
test).
"""

from __future__ import annotations

import httpx
import pytest

from cognitum.meta_proxy import MetaProxyClient, MetaProxyClientConfig
from cognitum.meta_proxy.auth import LocalBearerTokenCredentialProvider

_ORIGIN = "http://127.0.0.1:11435"
_META_LLM_GOVERNANCE_METHODS = ("models", "whoami", "usage", "ready", "batches", "pods")


def _credential_provider() -> LocalBearerTokenCredentialProvider:
    return LocalBearerTokenCredentialProvider(
        token="mh1.canary-local-token", normalized_origin=_ORIGIN, audience=_ORIGIN
    )


class TestProxyRejectsMetaLlmGovernanceCalls:
    def test_meta_proxy_client_exposes_none_of_meta_llms_governance_methods(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("no HTTP call is expected")

        client = MetaProxyClient(
            MetaProxyClientConfig(
                origin=_ORIGIN,
                transport=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
                local_credential_provider=_credential_provider(),
            )
        )
        for method in _META_LLM_GOVERNANCE_METHODS:
            not_a_callable = not hasattr(client, method) or not callable(getattr(client, method))
            msg = f"MetaProxyClient must not expose a callable {method!r} method (ADR-0019 §D7)"
            assert not_a_callable, msg

    @pytest.mark.asyncio
    async def test_invoking_a_governance_operation_fails_before_any_http_call(self) -> None:
        call_count = [0]

        async def handler(request: httpx.Request) -> httpx.Response:
            call_count[0] += 1
            raise AssertionError("no HTTP call is expected")

        client = MetaProxyClient(
            MetaProxyClientConfig(
                origin=_ORIGIN,
                transport=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
                local_credential_provider=_credential_provider(),
            )
        )
        for method in _META_LLM_GOVERNANCE_METHODS:
            with pytest.raises(AttributeError):
                getattr(client, method)()
        assert call_count[0] == 0

    @pytest.mark.asyncio
    async def test_control_a_real_supported_call_does_reach_the_fixture(self) -> None:
        """Proves the fixture-spy technique above is not a false negative."""
        seen_paths: list[str] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            seen_paths.append(request.url.path)
            return httpx.Response(
                200,
                json={
                    "proxy_token_valid": True,
                    "product_version": "0.1.0",
                    "protocol_version": "1.0",
                    "configured_plane": "local",
                    "selected_plane": "local",
                    "limitations": [],
                },
            )

        client = MetaProxyClient(
            MetaProxyClientConfig(
                origin=_ORIGIN,
                transport=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
                local_credential_provider=_credential_provider(),
            )
        )
        await client.status()
        assert seen_paths == ["/status"]
        assert all(not p.startswith("/v1/") for p in seen_paths)
