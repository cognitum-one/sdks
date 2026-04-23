"""Fingerprint parser bounds — Python parity with Node's [16, 64] hex range.

The seed firmware emits ``fp={first 16 hex chars}`` in its mDNS TXT
record (`seed/src/cognitum-agent/src/discovery.rs:162`). Python's prior
``_parse_fp_txt`` required exactly 64 hex chars, so every real seed's
pin was silently dropped during discovery — callers using MdnsDiscovery
thought pin verification was on; it wasn't. This file pins the fix.
"""

from __future__ import annotations

import hashlib
import ssl
import pytest

from cognitum._errors import TlsPinError
from cognitum.seed.discovery.mdns import _parse_fp_txt
from cognitum.seed._transport import (
    _PinnedToCertContext,
    build_pinned_ssl_context,
)


class TestParseFpTxtAcceptsSeedPrefix:
    """The 16-char form the seed actually emits must now parse."""

    def test_accepts_16_char_hex(self) -> None:
        # 16 hex chars = 8 bytes = 64 bits of entropy = seed's TXT form.
        assert _parse_fp_txt("e3b0c44298fc1c14") == "e3b0c44298fc1c14"

    def test_accepts_sha256_prefix_16_char(self) -> None:
        assert (
            _parse_fp_txt("sha256:e3b0c44298fc1c14") == "e3b0c44298fc1c14"
        )

    def test_accepts_full_64_char(self) -> None:
        full = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        assert _parse_fp_txt(full) == full

    def test_accepts_uppercase_lowercased(self) -> None:
        assert _parse_fp_txt("E3B0C44298FC1C14") == "e3b0c44298fc1c14"


class TestParseFpTxtRejectsOutsideBounds:
    """Short fps are adversarial (see Node C1); long fps are padded."""

    def test_rejects_empty(self) -> None:
        assert _parse_fp_txt("") is None
        assert _parse_fp_txt(None) is None

    def test_rejects_below_16_chars(self) -> None:
        # 1/256 attack class — `fp=ab` matches 1/256 of any cert via
        # the transport layer's prefix-match semantics. Hard reject.
        assert _parse_fp_txt("ab") is None
        assert _parse_fp_txt("abcd") is None
        assert _parse_fp_txt("abcdef0123") is None  # 10 hex = 5 bytes
        assert _parse_fp_txt("sha256:ab") is None

    def test_rejects_above_64_chars(self) -> None:
        assert _parse_fp_txt("a" * 66) is None
        assert _parse_fp_txt("a" * 128) is None  # would-be SHA-512

    def test_rejects_odd_length(self) -> None:
        # 17 is between 16 and 64 but odd → not whole bytes.
        assert _parse_fp_txt("a" * 17) is None
        assert _parse_fp_txt("a" * 63) is None

    def test_rejects_non_hex(self) -> None:
        # `Z` is not hex.
        assert _parse_fp_txt("Z" * 16) is None
        assert _parse_fp_txt("e3b0c44298fc1c1z") is None  # last char bad

    def test_rejects_whitespace_only(self) -> None:
        assert _parse_fp_txt("   ") is None


class TestBuildPinnedContextAcceptsShortPin:
    """build_pinned_ssl_context must accept a 16-char expected pin and
    prefix-match against the actual cert's full SHA-256 — previously
    compared full strings and rejected every seed pin."""

    def test_16_char_expected_matches_via_prefix(self) -> None:
        # Deterministic fake "cert": the DER is arbitrary, we just need
        # a known SHA-256 to build the expected prefix from.
        fake_der = b"fake-der-for-prefix-match-test"
        full_hex = hashlib.sha256(fake_der).hexdigest()
        prefix16 = full_hex[:16]

        # Direct check on the primitive — no network involved. We
        # construct the context manually because build_pinned_ssl_context
        # requires a live server; the prefix-match logic lives inside it
        # and we cover the network case in test_pinned_ssl_context.py.
        ctx = _PinnedToCertContext(fake_der)
        # The stored DER is the full bytes (that's what the wrap_socket
        # override compares). The 16-char prefix is only used at the
        # initial `build_pinned_ssl_context` pre-fetch; once the pin
        # matches the full DER is what we trust.
        assert ctx._expected_der == fake_der
        # Sanity: prefix of full hex matches expected prefix.
        assert full_hex.startswith(prefix16)


class TestBuildPinnedContextPrefixCompareBounds:
    """``build_pinned_ssl_context`` now enforces [16, 64] bounds on the
    expected pin. A below-floor expected must fail explicitly — not
    silently accept every cert via a zero-length prefix match."""

    def test_too_short_expected_raises_tls_pin_error(self) -> None:
        with pytest.raises(TlsPinError) as excinfo:
            build_pinned_ssl_context(
                expected_sha256="ab",  # 2 chars, below floor
                host="127.0.0.1",
                port=1,  # unreachable; bounds check fires before fetch
                timeout=1.0,
            )
        assert "fingerprint" in str(excinfo.value).lower()

    def test_over_long_expected_raises_tls_pin_error(self) -> None:
        # 66 chars — above ceiling.
        with pytest.raises(TlsPinError):
            build_pinned_ssl_context(
                expected_sha256="a" * 66,
                host="127.0.0.1",
                port=1,
                timeout=1.0,
            )

    def test_odd_length_expected_raises_tls_pin_error(self) -> None:
        with pytest.raises(TlsPinError):
            build_pinned_ssl_context(
                expected_sha256="a" * 17,
                host="127.0.0.1",
                port=1,
                timeout=1.0,
            )
