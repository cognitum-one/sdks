#!/usr/bin/env python3
"""Drive the published PyPI SDK against the live Cognitum gateway.

Run this only from a clean environment containing ``cognitum-sdk`` from
PyPI. Assertions deliberately check response meaning, not HTTP status alone.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from time import monotonic

from cognitum.agentic import StaticApiKeyCredentialProvider
from cognitum.meta_llm import (
    AnthropicMessageParam,
    AnthropicMessageRequest,
    ChatCompletionRequest,
    ChatMessage,
    MetaLlmClient,
    MetaLlmClientConfig,
    UsageQuery,
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


async def check(name: str, operation: Callable[[], Awaitable[None]]) -> str | None:
    started = monotonic()
    try:
        await operation()
        print(f"ok   {name} ({(monotonic() - started) * 1000:.0f}ms)")
        return None
    except Exception as error:  # noqa: BLE001 - aggregate all independent live checks
        print(f"FAIL {name}: {error}")
        return f"{name}: {error}"


async def main() -> None:
    base_url = os.getenv("COGNITUM_API_BASE_URL", "https://api.cognitum.one")
    api_key = os.getenv("COGNITUM_API_KEY")
    require(bool(api_key), "COGNITUM_API_KEY is not set")

    client = MetaLlmClient(
        MetaLlmClientConfig(
            base_url=base_url,
            credential_provider=StaticApiKeyCredentialProvider(
                product="meta-llm",
                normalized_origin=base_url,
                audience=base_url,
                api_key=api_key,
            ),
        )
    )
    print(f"live Python smoke against {base_url}")

    async def health() -> None:
        result = await client.health()
        require(result.data.status == "healthy", f"expected healthy, got {result.data.status!r}")

    async def models() -> None:
        result = await client.models()
        ids = [model.id for model in result.data.models]
        require(bool(ids), "model list is empty")
        require("cognitum-low" in ids, f"model list is missing cognitum-low; got {ids}")

    async def whoami() -> None:
        result = await client.whoami()
        identity = result.data
        require(
            bool(identity.account_id or identity.credential_type or identity.tenant_id),
            f"identity response has no identity fields: {identity!r}",
        )

    async def chat_completion() -> None:
        result = await client.chat.completions(
            ChatCompletionRequest(
                model="cognitum-low",
                messages=[ChatMessage(role="user", content="Reply with exactly: ok")],
                max_tokens=8,
            )
        )
        require(bool(result.data.choices), "completion has no choices")
        content = result.data.choices[0].message.content
        require(isinstance(content, str) and bool(content.strip()), f"empty completion: {content!r}")
        require(
            result.data.usage is not None and result.data.usage.total_tokens > 0,
            "completion reported zero or missing total_tokens",
        )

    async def messages_create() -> None:
        result = await client.messages.create(
            AnthropicMessageRequest(
                model="cognitum-low",
                messages=[AnthropicMessageParam(role="user", content="Reply with exactly: ok")],
                max_tokens=8,
            )
        )
        text = next(
            (block.get("text") for block in result.data.content if block.get("type") == "text"),
            None,
        )
        require(isinstance(text, str) and bool(text.strip()), f"empty message content: {result.data.content!r}")

    async def usage() -> None:
        month = datetime.now(timezone.utc).strftime("%Y-%m")
        result = await client.usage(UsageQuery(from_=month, to=month))
        require(
            result.data.totals.total_tokens is not None and result.data.totals.total_tokens > 0,
            "usage reports zero or missing total_tokens",
        )
        require(
            result.data.totals.requests is not None and result.data.totals.requests > 0,
            "usage reports zero monthly requests",
        )

    failures: list[str] = []
    for name, operation in (
        ("health reports healthy", health),
        ("models lists the tier aliases", models),
        ("whoami returns authenticated identity", whoami),
        ("chat.completions returns real content", chat_completion),
        ("messages.create returns real content", messages_create),
        ("usage returns non-empty monthly accounting", usage),
    ):
        failure = await check(name, operation)
        if failure:
            failures.append(failure)

    await client.aclose()
    if failures:
        raise RuntimeError(f"{len(failures)} live check(s) failed:\n- " + "\n- ".join(failures))
    print(f"\nall Python live checks passed against {base_url}")


if __name__ == "__main__":
    asyncio.run(main())
