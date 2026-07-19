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
  - Genuine gap: ``HarnessaaSClient.solve()`` has NO capability-version
    check before its HTTP call, despite being simultaneously a mutation, a
    spend, and (per HarnessaaS's "untrusted repository and command
    execution" trust boundary) a code-execution trigger. Flagged as a
    follow-up in the issue #74 PR/issue rather than asserted here as
    passing behavior that does not exist.

Category mapping used below (all backed by real, currently-passing
production behavior):

  mutation        -> MetaHarnessClient.scaffold()        (applies a plan)
  spend           -> MetaProxyClient.preview.sponsored.chat.completions
  consent         -> MetaProxyClient.chat.completions (cognitum_cloud, no grant)
  installation    -> MetaHarnessClient.plan_scaffold()   (blocked in part on
                      package/template version disagreement, ADR-0026a §D7 #3)
  code execution  -> MetaHarnessClient.analyze_repository()
"""

from __future__ import annotations

import httpx
import pytest

from cognitum.agentic import ConsentRequiredError, UnsupportedCapabilityError
from cognitum.meta_llm import ChatCompletionRequest, ChatMessage
from cognitum.meta_proxy import MetaProxyChatCallOptions, MetaProxyClient, MetaProxyClientConfig
from cognitum.meta_proxy.auth import LocalBearerTokenCredentialProvider
from cognitum.meta_proxy.routing import RoutingIntent
from cognitum.metaharness import (
    ApplyApproval,
    GeneratorIdentity,
    LocalRepository,
    MetaHarnessClient,
    ScaffoldPlan,
    ScaffoldRequestV1,
    TemplateIdentity,
)

_ORIGIN = "http://127.0.0.1:11435"


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


class TestCapabilityFailClosed:
    @pytest.mark.asyncio
    async def test_mutation_scaffold_fails_closed(self) -> None:
        client = MetaHarnessClient()
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
            await client.scaffold(plan, approval)

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
    async def test_code_execution_analyze_repository_fails_closed(self) -> None:
        client = MetaHarnessClient()
        with pytest.raises(UnsupportedCapabilityError):
            await client.analyze_repository(LocalRepository(canonical_path="/tmp/repo"))

    @pytest.mark.asyncio
    async def test_spend_sponsored_chat_completions_fails_closed_before_http(self) -> None:
        client = MetaProxyClient(
            MetaProxyClientConfig(
                origin=_ORIGIN,
                transport=_refusing_transport(),
                local_credential_provider=_local_bearer_provider(),
            )
        )
        with pytest.raises(UnsupportedCapabilityError):
            await client.preview.sponsored.chat.completions(_chat_request())

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
