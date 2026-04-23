"""Regression tests for issue #17 — Python default-host allowlist must not
silently disable TLS for ``localhost`` / ``127.0.0.1``, and must honour
an explicit ``tls=`` argument strictly regardless of host.

Covers ADR-0007 §TLS "MUST NOT be disabled implicitly" + security-audit
finding P-B1.
"""

from __future__ import annotations

import ssl
import warnings

import pytest

from cognitum._errors import ConfigError
from cognitum.seed._config import SeedTLS, normalise_options
from cognitum.seed._transport import (
    _DEFAULT_SEED_HOSTS,
    _WARNED_DEFAULT_HOSTS,
    _is_default_host,
    build_verify,
)


class TestAllowlistScope:
    """``localhost`` / ``127.0.0.1`` must NOT be in the auto-insecure set."""

    def test_localhost_not_in_default_hosts(self) -> None:
        assert "localhost" not in _DEFAULT_SEED_HOSTS
        assert _is_default_host("localhost") is False
        assert _is_default_host("LocalHost") is False

    def test_127_not_in_default_hosts(self) -> None:
        assert "127.0.0.1" not in _DEFAULT_SEED_HOSTS
        assert _is_default_host("127.0.0.1") is False

    def test_physical_seed_hosts_still_allowed(self) -> None:
        # ADR-0007: physical-cable seed paths keep the self-signed
        # exception (USB link, cognitum.local, link-local).
        assert _is_default_host("169.254.42.1") is True
        assert _is_default_host("169.254.77.165") is True
        assert _is_default_host("cognitum.local") is True
        assert _is_default_host("fe80::1") is True


class TestLocalhostStrictByDefault:
    """A caller using the default ``tls=None`` on localhost must now see
    strict system-trust verification (which will reject self-signed)."""

    def test_localhost_default_tls_is_strict(self) -> None:
        # No tls= passed → tls_explicit is False, localhost is NOT a
        # default host, so build_verify refuses to silently accept
        # self-signed.
        opts = normalise_options("https://localhost:8443")
        assert opts.tls_explicit is False
        with pytest.raises(ConfigError):
            build_verify(
                opts.primary.host, opts.tls, tls_explicit=opts.tls_explicit
            )

    def test_127_default_tls_is_strict(self) -> None:
        opts = normalise_options("https://127.0.0.1:8443")
        with pytest.raises(ConfigError):
            build_verify(
                opts.primary.host, opts.tls, tls_explicit=opts.tls_explicit
            )


class TestLinkLocalSeedFallback:
    """169.254.42.1 with default tls still falls back to self-signed —
    that is the intended USB-link behaviour — but emits a one-time
    warning (ADR-0007 §TLS)."""

    def test_link_local_default_tls_falls_back_with_warning(self) -> None:
        _WARNED_DEFAULT_HOSTS.clear()
        opts = normalise_options("https://169.254.42.1:8443")
        assert opts.tls_explicit is False
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            verify = build_verify(
                opts.primary.host,
                opts.tls,
                tls_explicit=opts.tls_explicit,
            )
        assert isinstance(verify, ssl.SSLContext)
        assert verify.verify_mode == ssl.CERT_NONE
        assert any(
            issubclass(item.category, UserWarning)
            and "169.254.42.1" in str(item.message)
            for item in w
        ), f"expected UserWarning with host name, got {[str(i.message) for i in w]}"

    def test_link_local_warning_emitted_once_per_host(self) -> None:
        _WARNED_DEFAULT_HOSTS.clear()
        opts = normalise_options("https://169.254.42.1:8443")
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            build_verify(
                opts.primary.host, opts.tls, tls_explicit=opts.tls_explicit
            )
            build_verify(
                opts.primary.host, opts.tls, tls_explicit=opts.tls_explicit
            )
            build_verify(
                opts.primary.host, opts.tls, tls_explicit=opts.tls_explicit
            )
        ua_warnings = [x for x in w if issubclass(x.category, UserWarning)]
        assert len(ua_warnings) == 1


class TestExplicitTlsHonored:
    """When the caller passes ``tls=...`` explicitly, it wins over the
    default-host allowlist regardless of host (issue #17)."""

    def test_localhost_with_explicit_insecure_true_allowed(self) -> None:
        opts = normalise_options(
            "https://localhost:8443",
            tls=SeedTLS(insecure=True),
        )
        assert opts.tls_explicit is True
        assert (
            build_verify(
                opts.primary.host, opts.tls, tls_explicit=opts.tls_explicit
            )
            is False
        )

    def test_localhost_with_explicit_default_tls_is_strict(self) -> None:
        # `SeedTLS()` = verify=True, insecure=False, no trust material.
        # Even though the host is localhost, the explicit opt-in must be
        # honoured strictly (no silent self-signed).
        opts = normalise_options(
            "https://localhost:8443",
            tls=SeedTLS(),
        )
        assert opts.tls_explicit is True
        with pytest.raises(ConfigError):
            build_verify(
                opts.primary.host, opts.tls, tls_explicit=opts.tls_explicit
            )

    def test_link_local_with_explicit_default_tls_is_strict(self) -> None:
        # Even for 169.254.42.1, passing tls=SeedTLS() explicitly means
        # "I want strict TLS" — honour it. The USB-link self-signed
        # fallback only applies when the caller provided NO tls at all.
        opts = normalise_options(
            "https://169.254.42.1:8443",
            tls=SeedTLS(),
        )
        assert opts.tls_explicit is True
        with pytest.raises(ConfigError):
            build_verify(
                opts.primary.host, opts.tls, tls_explicit=opts.tls_explicit
            )

    def test_link_local_with_explicit_ca_pem_honoured(self) -> None:
        # Supplying ca_pem works for any host, default or not — and it
        # does NOT fall back to CERT_NONE.
        # Self-signed EC (P-256) test CA generated for this test only;
        # never used to verify a real endpoint.
        pem = (
            "-----BEGIN CERTIFICATE-----\n"
            "MIIBeDCCAR2gAwIBAgIUbkgJFITIPCrKYVCSlqYTlWQnnQ0wCgYIKoZIzj0EAwIw\n"
            "ETEPMA0GA1UEAwwGVGVzdENBMB4XDTI2MDQyMjIxNDc0OFoXDTI3MDQyMjIxNDc0\n"
            "OFowETEPMA0GA1UEAwwGVGVzdENBMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n"
            "emxoHj5oiRTf1yroBt/DHjluqUtpXuOW90YDa6aQYTZ+x+M8bItPUMKaOeoVBWbx\n"
            "fUTb815tYunUVLL2fsCgRKNTMFEwHQYDVR0OBBYEFEC0zmNkiDeq/0ZxrsVlU4Zy\n"
            "6vjuMB8GA1UdIwQYMBaAFEC0zmNkiDeq/0ZxrsVlU4Zy6vjuMA8GA1UdEwEB/wQF\n"
            "MAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIhAJSLwq8V/GhkEUa/j97W8ue61IdxvaKs\n"
            "jPJLxex8FeyWAiEAsBWhv+ckonc8+I6/1z6nKASDFGrW563bg1zOXcRy1iA=\n"
            "-----END CERTIFICATE-----\n"
        )
        opts = normalise_options(
            "https://169.254.42.1:8443",
            tls=SeedTLS(ca_pem=pem),
        )
        # With ca_pem, build_verify returns an SSLContext that verifies
        # — it does NOT fall back to CERT_NONE.
        verify = build_verify(
            opts.primary.host, opts.tls, tls_explicit=opts.tls_explicit
        )
        assert isinstance(verify, ssl.SSLContext)
        assert verify.verify_mode == ssl.CERT_REQUIRED
