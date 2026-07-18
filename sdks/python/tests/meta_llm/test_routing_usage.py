"""ADR-0024b D11 migration step 1 (issue #59): routing controls + receipt/
usage read-only support. Mirrors the style of `test_nonstream.py` (PR #86)
and `test_client.py` (PR #85).

Explicitly out of scope (see the ADR and this issue's tracking notes):
batches, pods, bench, webhooks, guidance, collaboration, evolution,
MicroLoRA, flywheel, genome, brain, vectors, conditional hosts (§D5-§D8).
"""

from __future__ import annotations

import httpx
import pytest
import respx

from cognitum.agentic import AgenticError, StaticApiKeyCredentialProvider
from cognitum.agentic.credentials import Credential, CredentialAuthority, RedactedSecret
from cognitum.meta_llm import (
    ChatCompletionRequest,
    ChatMessage,
    MetaLlmClient,
    MetaLlmClientConfig,
    MetaLlmRoutingControls,
    ModelSelectorTier,
    UsageQuery,
)
from cognitum.meta_llm.types.receipt import parse_meta_llm_receipt
from cognitum.meta_llm.types.usage import parse_usage_summary

BASE_URL = "https://meta-llm.test.cognitum.one"


def _credential_provider() -> StaticApiKeyCredentialProvider:
    return StaticApiKeyCredentialProvider(
        api_key="sk-test-canary-1234",
        product="meta-llm",
        normalized_origin=BASE_URL,
        audience=BASE_URL,
    )


class _RefreshingCredentialProvider:
    """Same shape as `test_nonstream.py`'s `_RefreshingCredentialProvider` --
    a fresh secret each `acquire()` call, needed because
    `StaticApiKeyCredentialProvider.invalidate()` makes every subsequent
    `acquire()` fail permanently.
    """

    def __init__(self) -> None:
        self.acquire_calls = 0
        self.invalidate_calls = 0

    async def describe_authority(self, request: object) -> CredentialAuthority:
        return CredentialAuthority(
            provider_fingerprint="refreshing",
            product="meta-llm",
            normalized_origin=BASE_URL,
            audience=BASE_URL,
            principal="acct_refresh",
        )

    async def acquire(self, request: object) -> Credential:
        secret = "sk-v1" if self.acquire_calls == 0 else "sk-v2"
        self.acquire_calls += 1
        return Credential(
            scheme="X-API-Key",
            secret=RedactedSecret(secret),
            audience=BASE_URL,
            source="refreshing",
            authority=CredentialAuthority(
                provider_fingerprint="refreshing",
                product="meta-llm",
                normalized_origin=BASE_URL,
                audience=BASE_URL,
                principal="acct_refresh",
            ),
        )

    def identity(self) -> str:
        return "refreshing-credential-provider"

    async def invalidate(self, reason: str) -> None:
        del reason
        self.invalidate_calls += 1


def _chat_completion_body_with_receipt() -> dict:
    return {
        "id": "chatcmpl-1",
        "object": "chat.completion",
        "created": 1,
        "model": "meta-llm-large",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "hi there"},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        "cognitum_receipt": {
            "request_id": "req-abc",
            "resolved_tier": "mid",
            "resolved_model": "meta-llm-large-v2",
            "escalated": False,
            "cap_degraded": False,
            "routing_reason": "auto_selected_mid",
            "price": {"amount": "0.0042", "currency": "USD"},
            "cache_result": "miss",
            "fallback_used": False,
            "breaker_counts": {"meta-llm-large": 0},
            "costs": [
                {"source": "provider", "amount": 0.0042, "currency": "USD", "finality": "estimate"}
            ],
            # Deliberately not in `_KNOWN_RECEIPT_KEYS` -- must survive under `raw`.
            "a_future_governance_field": {"some": "value"},
        },
    }


def _chat_request(routing_controls: MetaLlmRoutingControls | None = None) -> ChatCompletionRequest:
    return ChatCompletionRequest(
        model="meta-llm-large",
        messages=[ChatMessage(role="user", content="hello")],
        routing_controls=routing_controls,
    )


# ---------------------------------------------------------------------------
# Success: routing controls flow through the body, receipt decodes on
# success responses.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_chat_completions_sends_routing_controls_and_decodes_receipt() -> None:
    route = respx.post(f"{BASE_URL}/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=_chat_completion_body_with_receipt())
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    routing_controls = MetaLlmRoutingControls(
        model=ModelSelectorTier(tier="mid"),
        fallback_policy="best_effort",
        cache="semantic",
        safety="warn",
    )
    result = await client.chat.completions(_chat_request(routing_controls))

    assert result.data.id == "chatcmpl-1"
    assert route.call_count == 1
    sent_body = respx.calls.last.request.content
    import json

    sent_json = json.loads(sent_body)
    assert sent_json["routing_controls"]["model"] == {"tier": "mid", "kind": "tier"}
    assert sent_json["routing_controls"]["fallback_policy"] == "best_effort"

    assert result.meta.receipt is not None
    assert result.meta.receipt.request_id == "req-abc"
    assert result.meta.receipt.resolved_tier == "mid"
    assert result.meta.receipt.price is not None
    assert str(result.meta.receipt.price.amount) == "0.0042"
    assert result.meta.receipt.price.currency == "USD"
    assert len(result.meta.receipt.costs) == 1
    await client.aclose()


# ---------------------------------------------------------------------------
# Auth: usage() requires a credential_provider (same gate as whoami/models).
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_usage_requires_credential_provider() -> None:
    route = respx.get(f"{BASE_URL}/v1/usage")
    client = MetaLlmClient(MetaLlmClientConfig(base_url=BASE_URL))

    with pytest.raises(AgenticError) as exc_info:
        await client.usage(UsageQuery(from_="2026-01", to="2026-06"))

    assert exc_info.value.kind == "authentication"
    assert route.call_count == 0
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_usage_scopes_the_query_to_the_authenticated_account_only() -> None:
    route = respx.get(f"{BASE_URL}/v1/usage").mock(
        return_value=httpx.Response(200, json={"totals": {"requests": 3}})
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    await client.usage(
        UsageQuery(from_="2026-01", to="2026-06", model="meta-llm-large", group_by="model")
    )

    assert route.call_count == 1
    url = str(respx.calls.last.request.url)
    assert "from=2026-01" in url
    assert "to=2026-06" in url
    assert "model=meta-llm-large" in url
    assert "group_by=model" in url
    await client.aclose()


# ---------------------------------------------------------------------------
# Validation: unrecognized enum values are rejected before any network call;
# malformed usage() query ranges are rejected the same way.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_rejects_unrecognized_model_selector_before_any_request() -> None:
    route = respx.post(f"{BASE_URL}/v1/chat/completions")
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    class _BogusSelector:
        kind = "raw_provider_model_id"
        model_id = "gpt-9000"

    request = _chat_request(MetaLlmRoutingControls(model=_BogusSelector()))  # type: ignore[arg-type]

    with pytest.raises(AgenticError) as exc_info:
        await client.chat.completions(request)

    assert exc_info.value.kind == "validation"
    assert route.call_count == 0
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_rejects_unrecognized_fallback_policy_before_any_request() -> None:
    route = respx.post(f"{BASE_URL}/v1/chat/completions")
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    request = _chat_request(MetaLlmRoutingControls(fallback_policy="retry_forever"))  # type: ignore[arg-type]

    with pytest.raises(AgenticError) as exc_info:
        await client.chat.completions(request)

    assert exc_info.value.kind == "validation"
    assert route.call_count == 0
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_usage_rejects_malformed_yyyy_mm_range_before_any_request() -> None:
    route = respx.get(f"{BASE_URL}/v1/usage")
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    with pytest.raises(AgenticError) as exc_info:
        await client.usage(UsageQuery(from_="2026-1", to="2026-06"))

    assert exc_info.value.kind == "validation"
    assert route.call_count == 0
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_usage_rejects_range_where_from_is_after_to() -> None:
    route = respx.get(f"{BASE_URL}/v1/usage")
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    with pytest.raises(AgenticError) as exc_info:
        await client.usage(UsageQuery(from_="2026-06", to="2026-01"))

    assert exc_info.value.kind == "validation"
    assert route.call_count == 0
    await client.aclose()


# ---------------------------------------------------------------------------
# Unknown-field preservation: response parsing never drops evidence it
# doesn't recognize yet (ADR-0024b §D2: "Unknown received values are
# preserved").
# ---------------------------------------------------------------------------


def test_parse_meta_llm_receipt_preserves_unrecognized_field_under_raw() -> None:
    receipt = parse_meta_llm_receipt(_chat_completion_body_with_receipt()["cognitum_receipt"])
    assert receipt is not None
    assert receipt.raw is not None
    assert receipt.raw["a_future_governance_field"] == {"some": "value"}


def test_parse_meta_llm_receipt_preserves_unrecognized_resolved_tier_value() -> None:
    receipt = parse_meta_llm_receipt({"request_id": "req-x", "resolved_tier": "ultra_future_tier"})
    assert receipt is not None
    assert receipt.resolved_tier == "ultra_future_tier"


def test_parse_usage_summary_preserves_unrecognized_field_under_raw() -> None:
    summary = parse_usage_summary(
        {"totals": {"requests": 5}, "a_future_governance_field": {"some": "value"}}
    )
    assert summary.raw is not None
    assert summary.raw["a_future_governance_field"] == {"some": "value"}


def test_parse_usage_summary_returns_empty_totals_rather_than_fabricating_usage() -> None:
    summary = parse_usage_summary({})
    assert summary.totals.requests is None
    assert summary.totals.total_tokens is None


# ---------------------------------------------------------------------------
# Retry invariant (§D4, critical correctness rule): "The SDK never raises
# tier, enables escalation, changes cache, selects best effort, or changes
# payer during retry." -- proves the routing_controls set on the ORIGINAL
# request are sent byte-identical on every retry attempt.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_routing_controls_sent_byte_identical_across_a_502_retry() -> None:
    route = respx.post(f"{BASE_URL}/v1/chat/completions")
    route.side_effect = [
        httpx.Response(502, json={"error": "bad gateway"}),
        httpx.Response(200, json=_chat_completion_body_with_receipt()),
    ]
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    routing_controls = MetaLlmRoutingControls(
        model=ModelSelectorTier(tier="high"),
        min_tier="mid",
        max_tier="high",
        fallback_policy="fail_fast",
        escalation="post_hoc",
        cache="exact",
        safety="block",
        sub_tenant_id="attribution-only-token",
    )

    result = await client.chat.completions(_chat_request(routing_controls))

    assert result.data.id == "chatcmpl-1"
    assert route.call_count == 2

    first_body = respx.calls[0].request.content
    second_body = respx.calls[1].request.content
    import json

    first_json = json.loads(first_body)
    second_json = json.loads(second_body)

    # Byte-identical serialization, not just deep-equal, proves no silent
    # reordering/mutation crept in between attempts.
    assert json.dumps(first_json["routing_controls"], sort_keys=True) == json.dumps(
        second_json["routing_controls"], sort_keys=True
    )
    assert second_json["routing_controls"] == first_json["routing_controls"]

    # The Idempotency-Key must also be stable -- otherwise "retry" would
    # really be a second, unrelated logical call (ADR-0024a §D7).
    key_1 = respx.calls[0].request.headers.get("idempotency-key")
    key_2 = respx.calls[1].request.headers.get("idempotency-key")
    assert key_1 is not None
    assert key_1 == key_2
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_routing_controls_never_mutated_across_a_401_refresh() -> None:
    route = respx.post(f"{BASE_URL}/v1/chat/completions")
    route.side_effect = [
        httpx.Response(401, json={"error": "expired"}),
        httpx.Response(200, json=_chat_completion_body_with_receipt()),
    ]
    provider = _RefreshingCredentialProvider()
    client = MetaLlmClient(MetaLlmClientConfig(base_url=BASE_URL, credential_provider=provider))

    routing_controls = MetaLlmRoutingControls(
        min_tier="low", fallback_policy="fail_fast", escalation="buffered", cache="disabled"
    )

    await client.chat.completions(_chat_request(routing_controls))

    assert route.call_count == 2
    import json

    first_json = json.loads(respx.calls[0].request.content)
    second_json = json.loads(respx.calls[1].request.content)
    assert second_json["routing_controls"] == first_json["routing_controls"]

    # The credential (payer) DID change across the 401 refresh (that part
    # is expected/required) -- but routing_controls stayed identical
    # regardless, proving the payer swap never leaked into a routing/cache/
    # escalation/tier mutation.
    assert respx.calls[0].request.headers.get("x-api-key") == "sk-v1"
    assert respx.calls[1].request.headers.get("x-api-key") == "sk-v2"
    await client.aclose()
