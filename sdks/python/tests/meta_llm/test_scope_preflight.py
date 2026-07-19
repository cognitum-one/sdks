"""ADR-0022 §D5 scope preflight, wired into `MetaLlmClient`'s shared
request-building path (`nonstream.py`'s `_require_credential` for
completion-family routes, `client.py`'s `_get_json` for
`whoami`/`models`/`usage`). "Before a billable or mutating call, a
provider with known granted scopes is checked locally. Missing scope
returns `PermissionDeniedError` before I/O." Every "blocked" case below
asserts the mocked HTTP route was never called (`route.call_count == 0`).
"""

from __future__ import annotations

import httpx
import pytest
import respx

from cognitum.agentic import CredentialAuthority
from cognitum.agentic.credentials import Credential, RedactedSecret
from cognitum.meta_llm import ChatCompletionRequest, ChatMessage, MetaLlmClient, MetaLlmClientConfig

BASE_URL = "https://meta-llm.test.cognitum.one"


class _ScopedCredentialProvider:
    """Minimal `CredentialProvider` returning a fixed `granted_scopes`
    (or `None` for "unknown") on every `acquire()` call."""

    def __init__(self, granted_scopes: list[str] | None) -> None:
        self._granted_scopes = granted_scopes

    async def describe_authority(self, request: object) -> CredentialAuthority:
        return CredentialAuthority(
            provider_fingerprint="scoped-test",
            product="meta-llm",
            normalized_origin=BASE_URL,
            audience=BASE_URL,
        )

    async def acquire(self, request: object) -> Credential:
        return Credential(
            scheme="Bearer",
            secret=RedactedSecret("oauth-test-token"),
            audience=BASE_URL,
            source="scoped-test-provider",
            granted_scopes=self._granted_scopes,
            authority=CredentialAuthority(
                provider_fingerprint="scoped-test",
                product="meta-llm",
                normalized_origin=BASE_URL,
                audience=BASE_URL,
                effective_scopes=self._granted_scopes,
            ),
        )

    def identity(self) -> str:
        return "scoped-test-provider"

    async def invalidate(self, reason: str) -> None:
        del reason


def _chat_request() -> ChatCompletionRequest:
    return ChatCompletionRequest(
        model="meta-llm-large", messages=[ChatMessage(role="user", content="hello")]
    )


def _chat_completion_body() -> dict:
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
    }


@pytest.mark.asyncio
@respx.mock
async def test_blocks_chat_completions_before_http_when_scopes_known_insufficient() -> None:
    route = respx.post(f"{BASE_URL}/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=_chat_completion_body())
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(
            base_url=BASE_URL,
            credential_provider=_ScopedCredentialProvider(["some-other-scope"]),
        )
    )
    with pytest.raises(Exception) as exc_info:
        await client.chat.completions(_chat_request())
    assert exc_info.value.kind == "permission_denied"  # type: ignore[attr-defined]
    assert route.call_count == 0
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_allows_chat_completions_through_when_scopes_unknown() -> None:
    route = respx.post(f"{BASE_URL}/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=_chat_completion_body())
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(
            base_url=BASE_URL,
            credential_provider=_ScopedCredentialProvider(None),
        )
    )
    result = await client.chat.completions(_chat_request())
    assert result.data.id == "chatcmpl-1"
    assert route.call_count == 1
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_allows_chat_completions_through_when_scopes_known_sufficient() -> None:
    route = respx.post(f"{BASE_URL}/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=_chat_completion_body())
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(
            base_url=BASE_URL,
            credential_provider=_ScopedCredentialProvider(["meta-llm.inference"]),
        )
    )
    result = await client.chat.completions(_chat_request())
    assert result.data.id == "chatcmpl-1"
    assert route.call_count == 1
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_blocks_whoami_before_http_when_scopes_known_insufficient() -> None:
    route = respx.get(f"{BASE_URL}/v1/whoami").mock(
        return_value=httpx.Response(200, json={"account_id": "acct_1"})
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(
            base_url=BASE_URL,
            credential_provider=_ScopedCredentialProvider(["meta-llm.inference"]),
        )
    )
    with pytest.raises(Exception) as exc_info:
        await client.whoami()
    assert exc_info.value.kind == "permission_denied"  # type: ignore[attr-defined]
    assert route.call_count == 0
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_allows_whoami_through_when_scopes_unknown() -> None:
    route = respx.get(f"{BASE_URL}/v1/whoami").mock(
        return_value=httpx.Response(200, json={"account_id": "acct_1"})
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(
            base_url=BASE_URL,
            credential_provider=_ScopedCredentialProvider(None),
        )
    )
    result = await client.whoami()
    assert result.data.account_id == "acct_1"
    assert route.call_count == 1
    await client.aclose()
