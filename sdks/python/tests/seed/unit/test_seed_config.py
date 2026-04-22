"""Unit tests for cognitum.seed._config — Phase 1 single-endpoint mode."""

from __future__ import annotations

import pytest

from cognitum.seed import SeedAuth, SeedClient, SeedTLS
from cognitum.seed._config import Endpoint, normalise_options
from cognitum.seed._errors import ConfigError


class TestEndpointParse:
    def test_accepts_full_url(self) -> None:
        ep = Endpoint.parse("https://cognitum.local:8443")
        assert ep.scheme == "https"
        assert ep.host == "cognitum.local"
        assert ep.port == 8443
        assert ep.url == "https://cognitum.local:8443"

    def test_adds_default_scheme_and_port(self) -> None:
        ep = Endpoint.parse("cognitum.local")
        assert ep.scheme == "https"
        assert ep.port == 8443

    def test_http_gets_port_80_if_unspecified(self) -> None:
        ep = Endpoint.parse("http://cognitum.local")
        assert ep.port == 80

    def test_rejects_empty(self) -> None:
        with pytest.raises(ConfigError):
            Endpoint.parse("")

    def test_rejects_bad_scheme(self) -> None:
        with pytest.raises(ConfigError):
            Endpoint.parse("ftp://host")

    def test_rejects_missing_host(self) -> None:
        with pytest.raises(ConfigError):
            Endpoint.parse("https://")


class TestNormaliseOptions:
    def test_single_string(self) -> None:
        opts = normalise_options("https://localhost:18443")
        assert len(opts.endpoints) == 1
        assert opts.primary.host == "localhost"
        assert opts.primary.port == 18443

    def test_one_element_list_allowed(self) -> None:
        opts = normalise_options(["https://cognitum.local:8443"])
        assert opts.primary.host == "cognitum.local"

    def test_mesh_rejected_with_phase_1_5_message(self) -> None:
        with pytest.raises(ConfigError) as exc:
            normalise_options([
                "https://a:8443",
                "https://b:8443",
            ])
        assert "mesh mode in Phase 1.5" in str(exc.value.message)

    def test_empty_list_rejected(self) -> None:
        with pytest.raises(ConfigError):
            normalise_options([])

    def test_invalid_type_rejected(self) -> None:
        with pytest.raises(ConfigError):
            normalise_options(123)  # type: ignore[arg-type]

    def test_bad_routing_rejected(self) -> None:
        with pytest.raises(ConfigError):
            normalise_options("https://host:8443", routing="bogus")  # type: ignore[arg-type]

    def test_timeouts_must_be_three(self) -> None:
        with pytest.raises(ConfigError):
            normalise_options("https://host:8443", timeouts=(1.0, 2.0))  # type: ignore[arg-type]

    def test_timeouts_positive(self) -> None:
        with pytest.raises(ConfigError):
            normalise_options("https://host:8443", timeouts=(-1.0, 2.0, 3.0))

    def test_insecure_flips_verify(self) -> None:
        opts = normalise_options(
            "https://host:8443",
            tls=SeedTLS(insecure=True, verify=True),
        )
        assert opts.tls.insecure is True
        assert opts.tls.verify is False


class TestSeedClientConstruction:
    def test_string_endpoint_works(self) -> None:
        client = SeedClient(
            "https://localhost:18443",
            tls=SeedTLS(insecure=True),
        )
        assert client.options.primary.port == 18443
        client.close()

    def test_mesh_list_raises(self) -> None:
        with pytest.raises(ConfigError) as exc:
            SeedClient(
                ["https://a:8443", "https://b:8443"],
                tls=SeedTLS(insecure=True),
            )
        assert "mesh mode in Phase 1.5" in str(exc.value.message)

    def test_has_all_resources(self) -> None:
        with SeedClient(
            "https://cognitum.local:8443", tls=SeedTLS(insecure=True)
        ) as client:
            assert hasattr(client, "pair")
            assert hasattr(client, "store")
            assert hasattr(client, "witness")
            assert hasattr(client, "custody")
            assert hasattr(client, "ota")
            # Top-level convenience methods exist (but we don't call them).
            assert callable(client.status)
            assert callable(client.identity)

    def test_auth_token_attached(self) -> None:
        client = SeedClient(
            "https://cognitum.local:8443",
            auth=SeedAuth(pairing_token="abc"),
            tls=SeedTLS(insecure=True),
        )
        # httpx normalises header names to lowercase; both should be present.
        hdrs = client._transport._client.headers
        assert hdrs.get("X-Pairing-Token") == "abc"
        client.close()

    def test_non_default_host_without_tls_material_raises(self) -> None:
        # Requires trust material for non-default host.
        with pytest.raises(ConfigError):
            SeedClient(
                "https://example.com:8443",
                tls=SeedTLS(verify=True),
            )

    def test_non_default_host_with_insecure_allowed(self) -> None:
        client = SeedClient(
            "https://example.com:8443",
            tls=SeedTLS(insecure=True),
        )
        client.close()
