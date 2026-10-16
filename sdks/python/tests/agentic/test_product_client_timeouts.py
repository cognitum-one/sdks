"""Product clients must not inherit httpx's implicit 5-second timeout.

Without an explicit ``timeout=``, ``httpx.AsyncClient()`` gives up on any
read after 5 s, so a generation, a HarnessaaS ``solve()`` or a stream's
first byte that took longer failed with ``"... request failed: "`` (httpx
timeouts stringify to an empty message). The default transports now bound
only the connect phase, a caller can still pass its own ``transport`` to
choose a timeout, and the transport error names the exception type.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from cognitum.agentic import AgenticError, StaticApiKeyCredentialProvider
from cognitum.harnessaas import HarnessaaSClient, HarnessaaSClientConfig
from cognitum.meta_llm import MetaLlmClient, MetaLlmClientConfig
from cognitum.meta_proxy import MetaProxyClient, MetaProxyClientConfig


def _assert_reads_unbounded(transport: httpx.AsyncClient) -> None:
    timeout = transport.timeout
    assert timeout.read is None, f"read timeout is {timeout.read}, expected none"
    assert timeout.write is None
    assert timeout.pool is None
    assert timeout.connect == 10.0


def test_meta_llm_default_transport_has_no_read_timeout() -> None:
    client = MetaLlmClient(MetaLlmClientConfig(base_url="https://meta-llm.test.cognitum.one"))
    _assert_reads_unbounded(client._transport)


def test_harnessaas_default_transport_has_no_read_timeout() -> None:
    client = HarnessaaSClient(HarnessaaSClientConfig(base_url="https://harnessaas.test.cognitum.one"))
    _assert_reads_unbounded(client._transport)


def test_meta_proxy_default_transport_has_no_read_timeout() -> None:
    client = MetaProxyClient(MetaProxyClientConfig())
    _assert_reads_unbounded(client._transport)
    # The ADR-0025a §D10 transport pins must survive the timeout change.
    assert client._transport.follow_redirects is False
    assert client._transport.trust_env is False


async def _slow_server(delay_s: float) -> tuple[asyncio.AbstractServer, str]:
    """A loopback HTTP server that waits ``delay_s`` before answering."""

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await reader.readuntil(b"\r\n\r\n")
        await asyncio.sleep(delay_s)
        body = b'{"status":"ok"}'
        writer.write(
            b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n"
            + f"content-length: {len(body)}\r\n\r\n".encode()
            + body
        )
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    return server, f"http://127.0.0.1:{port}"


@pytest.mark.asyncio
@pytest.mark.filterwarnings("ignore:MetaLlmClientConfig. HTTP")
async def test_caller_transport_timeout_applies_and_error_names_the_timeout() -> None:
    server, base_url = await _slow_server(delay_s=0.5)
    transport = httpx.AsyncClient(timeout=0.1)
    try:
        client = MetaLlmClient(
            MetaLlmClientConfig(
                base_url=base_url,
                allow_insecure_http=True,
                credential_provider=StaticApiKeyCredentialProvider(
                    api_key="sk-test-canary-1234",
                    product="meta-llm",
                    normalized_origin=base_url,
                    audience=base_url,
                ),
                transport=transport,
            )
        )
        with pytest.raises(AgenticError) as excinfo:
            await client.health()
    finally:
        await transport.aclose()
        server.close()
        await server.wait_closed()

    assert excinfo.value.kind == "transport"
    assert "ReadTimeout" in str(excinfo.value)
