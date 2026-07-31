"""ADR-0019 "Acceptance test" (issue #74), the ADR's own closing paragraph:

> For each of Node, Python, and Rust, instantiate all four clients with
> fake local transports and distinct sentinel credentials. Assert zero
> I/O during construction, assert each client sends only its own
> credential to its own fixture, assert an unknown capability blocks a
> billable mutation before I/O, and assert importing one namespace does
> not load another product implementation.

Written as one integration-style test exercising all four clients
together, mirroring the Node sibling
``tests/adr-0019-acceptance.test.ts``.
"""

from __future__ import annotations

import subprocess
import sys
import textwrap

import httpx
import pytest

from cognitum.agentic import StaticApiKeyCredentialProvider, UnsupportedCapabilityError
from cognitum.harnessaas import HarnessaaSClient, HarnessaaSClientConfig
from cognitum.meta_llm import MetaLlmClient, MetaLlmClientConfig
from cognitum.meta_proxy import MetaProxyClient, MetaProxyClientConfig
from cognitum.meta_proxy.auth import LocalBearerTokenCredentialProvider
from cognitum.metaharness import (
    ApplyApproval,
    GeneratorIdentity,
    MetaHarnessClient,
    ScaffoldPlan,
    TemplateIdentity,
)

_META_LLM_ORIGIN = "http://127.0.0.1:9101"
_HARNESSAAS_ORIGIN = "http://127.0.0.1:9102"
_META_PROXY_ORIGIN = "http://127.0.0.1:9103"

_SENTINEL_META_LLM = "sk-sentinel-meta-llm-AAA111"
_SENTINEL_META_PROXY = "mh1.sentinel-meta-proxy-BBB222"
_SENTINEL_HARNESSAAS = "cog_sentinel_harnessaas_CCC333"


def _run_snippet(snippet: str) -> str:
    result = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(snippet)],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def test_importing_meta_llm_does_not_load_any_other_product() -> None:
    """(d) importing one namespace does not load another product's
    implementation -- checked in a fresh interpreter, mirroring
    ``test_adr0019_import_smoke.py``.
    """
    snippet = """
        import sys
        import cognitum.meta_llm  # noqa: F401
        deny = ("cognitum.meta_proxy", "cognitum.metaharness", "cognitum.harnessaas")
        leaked = [m for m in deny if m in sys.modules]
        print(','.join(leaked) if leaked else 'CLEAN')
    """
    output = _run_snippet(snippet)
    assert output == "CLEAN", f"importing cognitum.meta_llm leaked: {output}"


class TestAcceptance:
    @pytest.mark.asyncio
    async def test_four_clients_zero_io_no_credential_bleed_capability_fails_closed(self) -> None:
        meta_llm_calls: list[httpx.Request] = []
        meta_proxy_calls: list[httpx.Request] = []
        harnessaas_calls: list[httpx.Request] = []

        async def meta_llm_handler(request: httpx.Request) -> httpx.Response:
            meta_llm_calls.append(request)
            return httpx.Response(200, json={"object": "list", "models": []})

        async def meta_proxy_handler(request: httpx.Request) -> httpx.Response:
            meta_proxy_calls.append(request)
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

        async def harnessaas_handler(request: httpx.Request) -> httpx.Response:
            harnessaas_calls.append(request)
            return httpx.Response(200, json={"request_id": "req-sentinel-check", "records": []})

        # -------------------------------------------------------------
        # (a) zero I/O during construction, for all four clients.
        # -------------------------------------------------------------
        meta_llm_client = MetaLlmClient(
            MetaLlmClientConfig(
                base_url=_META_LLM_ORIGIN,
                allow_insecure_http=True,
                transport=httpx.AsyncClient(transport=httpx.MockTransport(meta_llm_handler)),
                credential_provider=StaticApiKeyCredentialProvider(
                    api_key=_SENTINEL_META_LLM,
                    product="meta-llm",
                    normalized_origin=_META_LLM_ORIGIN,
                    audience=_META_LLM_ORIGIN,
                ),
            )
        )
        meta_proxy_client = MetaProxyClient(
            MetaProxyClientConfig(
                origin=_META_PROXY_ORIGIN,
                transport=httpx.AsyncClient(transport=httpx.MockTransport(meta_proxy_handler)),
                local_credential_provider=LocalBearerTokenCredentialProvider(
                    token=_SENTINEL_META_PROXY,
                    normalized_origin=_META_PROXY_ORIGIN,
                    audience=_META_PROXY_ORIGIN,
                ),
            )
        )
        metaharness_client = MetaHarnessClient()
        harnessaas_client = HarnessaaSClient(
            HarnessaaSClientConfig(
                base_url=_HARNESSAAS_ORIGIN,
                allow_insecure_http=True,
                transport=httpx.AsyncClient(transport=httpx.MockTransport(harnessaas_handler)),
                credential_provider=StaticApiKeyCredentialProvider(
                    api_key=_SENTINEL_HARNESSAAS,
                    product="harnessaas",
                    normalized_origin=_HARNESSAAS_ORIGIN,
                    audience=_HARNESSAAS_ORIGIN,
                ),
            )
        )

        assert isinstance(meta_llm_client, MetaLlmClient)
        assert isinstance(meta_proxy_client, MetaProxyClient)
        assert isinstance(metaharness_client, MetaHarnessClient)
        assert isinstance(harnessaas_client, HarnessaaSClient)
        assert meta_llm_calls == []
        assert meta_proxy_calls == []
        assert harnessaas_calls == []

        # -------------------------------------------------------------
        # (b) each client sends only its own credential to its own
        # fixture -- never another client's sentinel.
        # -------------------------------------------------------------
        await meta_llm_client.models()
        await meta_proxy_client.status()
        await harnessaas_client.lineage("req-sentinel-check")

        assert len(meta_llm_calls) == 1
        assert len(meta_proxy_calls) == 1
        assert len(harnessaas_calls) == 1

        meta_llm_headers = str(dict(meta_llm_calls[0].headers))
        meta_proxy_headers = str(dict(meta_proxy_calls[0].headers))
        harnessaas_headers = str(dict(harnessaas_calls[0].headers))

        assert _SENTINEL_META_LLM in meta_llm_headers
        assert _SENTINEL_META_PROXY in meta_proxy_headers
        assert _SENTINEL_HARNESSAAS in harnessaas_headers

        assert _SENTINEL_META_PROXY not in meta_llm_headers
        assert _SENTINEL_HARNESSAAS not in meta_llm_headers
        assert _SENTINEL_META_LLM not in meta_proxy_headers
        assert _SENTINEL_HARNESSAAS not in meta_proxy_headers
        assert _SENTINEL_META_LLM not in harnessaas_headers
        assert _SENTINEL_META_PROXY not in harnessaas_headers

        # -------------------------------------------------------------
        # (c) an unknown capability blocks a billable mutation before
        # I/O. MetaHarnessClient.scaffold() has no published bridge
        # capability yet (ADR-0026a §D7), so it fails closed, and none
        # of the three HTTP fixtures above see any additional call.
        # -------------------------------------------------------------
        calls_before = (len(meta_llm_calls), len(meta_proxy_calls), len(harnessaas_calls))

        plan = ScaffoldPlan(
            plan_id="plan_1",
            plan_digest="sha256:deadbeef",
            created_at="2026-07-18T00:00:00Z",
            expires_at="2026-07-18T00:10:00Z",
            generator_identity=GeneratorIdentity(product="metaharness-oss"),
            template_identity=TemplateIdentity(template="default"),
            canonical_target="/tmp/target",
            target_before_digest="sha256:before",
            request_digest="sha256:request",
        )
        approval = ApplyApproval(plan_digest="sha256:deadbeef", approved_at="2026-07-18T00:00:00Z")

        with pytest.raises(UnsupportedCapabilityError):
            await metaharness_client.scaffold(plan, approval)

        assert (len(meta_llm_calls), len(meta_proxy_calls), len(harnessaas_calls)) == calls_before
