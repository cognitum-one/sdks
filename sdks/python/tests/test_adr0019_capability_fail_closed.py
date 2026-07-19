"""ADR-0019 "Compliance and verification" #6 (issue #74): capability
fail-closed tests across five categories.

> Capability tests prove unknown product versions fail closed for
> mutation, spend, consent, installation, and code execution.

ADR-0019 §D6: "A method whose prerequisite capability is false or unknown
MUST fail locally with ``UnsupportedCapabilityError`` before causing spend,
mutation, consent, or code execution."

Audit (issue #74) performed before writing this file -- see the Node
sibling ``tests/adr-0019-capability-fail-closed.test.ts`` for the full
write-up; summary:

  - ``tests/metaharness/test_client.py`` already exhaustively covers every
    ``MetaHarnessClient`` method failing closed (no published bridge
    protocol exists yet, ADR-0026a §D7), but not framed against these five
    named categories nor asserting zero network I/O explicitly.
  - ``tests/meta_proxy/test_consent.py`` and
    ``tests/meta_proxy/test_chat_completions_stream.py`` already cover
    "consent" and "spend" (sponsored) individually.
  - Gap CLOSED (this pass): ``HarnessaaSClient.solve()`` previously
    performed NO capability-version check before its HTTP call, despite
    being simultaneously a mutation, a spend, and (per HarnessaaS's
    "untrusted repository and command execution" trust boundary) a
    code-execution trigger. ``solve()`` now calls ``self.capabilities()``
    and fails closed with ``UnsupportedCapabilityError`` BEFORE any HTTP
    I/O when either the base ``solve`` feature or the requested
    ``vertical``'s specific feature (``solve.vertical.<vertical>``) is not
    affirmatively ``True`` in the resolved capability set -- the real,
    non-vacuous dimension being that only the ``code-repair`` vertical is
    modeled/serialized by this SDK pass (``cognitum.harnessaas.types``'s
    module docstring: the other three verticals each need a compound
    request field this client does not build).

Category mapping used below. ``installation`` has no HarnessaaS analog
(HarnessaaS installs nothing), so it stays on
``MetaHarnessClient.plan_scaffold()``; every other category now exercises
real, currently-passing production behavior against
``HarnessaaSClient.solve()`` directly:

  mutation        -> HarnessaaSClient.solve() (unsupported vertical, mutating remote solve)
  spend           -> HarnessaaSClient.solve() (unsupported vertical, billable model spend)
  consent         -> MetaProxyClient.chat.completions (cognitum_cloud, no grant)
  installation    -> MetaHarnessClient.plan_scaffold()   (blocked in part on
                      package/template version disagreement, ADR-0026a §D7 #3)
  code execution  -> HarnessaaSClient.solve() (unsupported vertical, untrusted sandbox execution)
"""

from __future__ import annotations

import httpx
import pytest
import respx

from cognitum.agentic import (
    ConsentRequiredError,
    StaticApiKeyCredentialProvider,
    UnsupportedCapabilityError,
)
from cognitum.harnessaas import HarnessaaSClient, HarnessaaSClientConfig, HarnessaaSSolveRequest
from cognitum.meta_llm import ChatCompletionRequest, ChatMessage
from cognitum.meta_proxy import MetaProxyChatCallOptions, MetaProxyClient, MetaProxyClientConfig
from cognitum.meta_proxy.auth import LocalBearerTokenCredentialProvider
from cognitum.meta_proxy.routing import RoutingIntent
from cognitum.metaharness import MetaHarnessClient, ScaffoldRequestV1

_ORIGIN = "http://127.0.0.1:11435"
_HARNESSAAS_ORIGIN = "https://harnessaas.compliance-test.cognitum.one"


def _harnessaas_client() -> HarnessaaSClient:
    return HarnessaaSClient(
        HarnessaaSClientConfig(
            base_url=_HARNESSAAS_ORIGIN,
            credential_provider=StaticApiKeyCredentialProvider(
                api_key="cog_compliance_canary",
                product="harnessaas",
                normalized_origin=_HARNESSAAS_ORIGIN,
                audience=_HARNESSAAS_ORIGIN,
            ),
        )
    )


def _refusing_transport() -> httpx.AsyncClient:
    async def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no HTTP call expected -- the capability/consent gate must fire first")

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _local_bearer_provider() -> LocalBearerTokenCredentialProvider:
    return LocalBearerTokenCredentialProvider(
        token="mh1.canary-local-token", normalized_origin=_ORIGIN, audience=_ORIGIN
    )


def _chat_request() -> ChatCompletionRequest:
    return ChatCompletionRequest(
        model="gpt-proxy", messages=[ChatMessage(role="user", content="hello")]
    )


def _unsupported_vertical_solve_request(vertical: str) -> HarnessaaSSolveRequest:
    return HarnessaaSSolveRequest(
        repo="https://github.com/acme/widget.git",
        test_command="pytest -k test_widget",
        issue="Widget renders twice",
        vertical=vertical,  # type: ignore[arg-type]
    )


class TestCapabilityFailClosed:
    @pytest.mark.asyncio
    async def test_mutation_harnessaas_solve_fails_closed(self) -> None:
        """`HarnessaaSClient.solve()` with a vertical this SDK pass does not
        model (`security-remediation` needs a `finding`/`scanner_command`
        compound field this client does not serialize). One real call
        embodies mutation + spend + code execution simultaneously
        (HarnessaaS's own "untrusted repository and command execution"
        trust boundary), so this and the two tests below each assert the
        same fail-closed outcome against the category they specifically
        care about.
        """
        with respx.mock:
            # No route mounted -- any HTTP request would raise inside respx.
            client = _harnessaas_client()
            with pytest.raises(UnsupportedCapabilityError):
                await client.solve(_unsupported_vertical_solve_request("security-remediation"))
            assert len(respx.calls) == 0
            await client.aclose()

    @pytest.mark.asyncio
    async def test_installation_plan_scaffold_fails_closed(self) -> None:
        client = MetaHarnessClient()
        request = ScaffoldRequestV1(
            name="demo",
            template="default",
            hosts=["claude-code"],
            target="/tmp/target",
            darwin=None,
        )
        with pytest.raises(UnsupportedCapabilityError):
            await client.plan_scaffold(request)

    @pytest.mark.asyncio
    async def test_code_execution_harnessaas_solve_fails_closed(self) -> None:
        with respx.mock:
            client = _harnessaas_client()
            with pytest.raises(UnsupportedCapabilityError):
                await client.solve(_unsupported_vertical_solve_request("dependency-migration"))
            assert len(respx.calls) == 0
            await client.aclose()

    @pytest.mark.asyncio
    async def test_spend_harnessaas_solve_fails_closed_before_billable_http(self) -> None:
        with respx.mock:
            client = _harnessaas_client()
            with pytest.raises(UnsupportedCapabilityError):
                await client.solve(_unsupported_vertical_solve_request("test-generation"))
            assert len(respx.calls) == 0
            await client.aclose()

    @pytest.mark.asyncio
    async def test_consent_chat_completions_fails_closed_before_http(self) -> None:
        client = MetaProxyClient(
            MetaProxyClientConfig(
                origin=_ORIGIN,
                transport=_refusing_transport(),
                local_credential_provider=_local_bearer_provider(),
                # Deliberately no consent_grants configured.
            )
        )
        options = MetaProxyChatCallOptions(
            routing_intent=RoutingIntent(
                required_plane="cognitum_cloud", allowed_planes=["cognitum_cloud"]
            )
        )
        with pytest.raises(ConsentRequiredError):
            await client.chat.completions(_chat_request(), options)
