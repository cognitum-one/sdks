"""Security audit C2 — TOCTOU fix for the Python TLS pin.

The previous design fetched the peer cert on one raw socket, cached
``_verified=True``, and let httpx open a DIFFERENT socket for the real
request. An attacker answering handshake #1 with the real cert and
handshake #2 with a forged cert bypassed the pin permanently.

This test file covers the TOCTOU-closing replacement:

* :func:`build_pinned_ssl_context` performs the initial fetch-and-verify
  and returns an SSLContext.
* The returned context's ``wrap_socket`` runs on the SAME handshake
  httpx uses; if the presented cert differs from the pinned DER it
  closes the socket before any request bytes cross the wire.

Each test stands up a real TLS server on ``127.0.0.1`` so we exercise
the actual ``ssl`` stack, not a mock.
"""

from __future__ import annotations

import hashlib
import socket
import ssl
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import pytest

from cognitum._errors import TlsPinError
from cognitum.seed._transport import (
    _PinnedToCertContext,
    build_pinned_ssl_context,
)


def _openssl_gen_self_signed(tmpdir: Path, suffix: str) -> tuple[Path, Path, bytes]:
    """Generate a fresh self-signed EC cert pair. Returns (cert_pem,
    key_pem, cert_der). Uses OpenSSL CLI so we don't add a
    `cryptography` dependency just for tests."""
    key_path = tmpdir / f"key_{suffix}.pem"
    cert_path = tmpdir / f"cert_{suffix}.pem"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:P-256",
            "-keyout",
            str(key_path),
            "-out",
            str(cert_path),
            "-days",
            "1",
            "-nodes",
            "-subj",
            f"/CN=seed-test-{suffix}",
        ],
        check=True,
        capture_output=True,
    )
    pem = cert_path.read_bytes()
    der = ssl.PEM_cert_to_DER_cert(pem.decode())
    return cert_path, key_path, der


class _EchoTlsServer:
    """Minimal one-shot TLS server that accepts a connection, reads one
    line, writes one line, closes. Used to exercise real handshake +
    wrap_socket in the tests below."""

    def __init__(self, cert_path: Path, key_path: Path) -> None:
        self._ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self._ctx.load_cert_chain(str(cert_path), str(key_path))
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(1)
        self.port: int = self._sock.getsockname()[1]
        self._thread: threading.Thread | None = None
        self._stop = False

    def start(self) -> None:
        def _serve() -> None:
            while not self._stop:
                try:
                    self._sock.settimeout(0.2)
                    try:
                        raw, _ = self._sock.accept()
                    except socket.timeout:
                        continue
                    try:
                        ss = self._ctx.wrap_socket(raw, server_side=True)
                        try:
                            _ = ss.recv(1024)
                            ss.sendall(b"ok\n")
                        finally:
                            try:
                                ss.unwrap()
                            except (OSError, ssl.SSLError):
                                pass
                            ss.close()
                    except (ssl.SSLError, OSError):
                        raw.close()
                except OSError:
                    break

        self._thread = threading.Thread(target=_serve, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop = True
        try:
            self._sock.close()
        except OSError:
            pass
        if self._thread is not None:
            self._thread.join(timeout=1.0)


@pytest.fixture
def cert_pair():
    with tempfile.TemporaryDirectory() as tmp:
        cert, key, der = _openssl_gen_self_signed(Path(tmp), "real")
        yield cert, key, der


@pytest.fixture
def attacker_cert_pair():
    # Freshly-generated adversarial cert with a DIFFERENT key — same
    # CN so hostname matching wouldn't help, but different DER bytes
    # so the pin check catches it.
    with tempfile.TemporaryDirectory() as tmp:
        cert, key, der = _openssl_gen_self_signed(Path(tmp), "evil")
        yield cert, key, der


class TestPinnedContextAcceptsMatchingCert:
    """The SSLContext accepts a connection whose cert DER matches the pin."""

    def test_accepts_exact_cert(self, cert_pair) -> None:
        cert, key, der = cert_pair
        server = _EchoTlsServer(cert, key)
        server.start()
        try:
            time.sleep(0.05)  # let the listener start
            ctx = _PinnedToCertContext(der)
            with socket.create_connection(("127.0.0.1", server.port)) as raw:
                wrapped = ctx.wrap_socket(raw, server_hostname="seed-test-real")
                try:
                    wrapped.sendall(b"hello\n")
                    assert wrapped.recv(32) == b"ok\n"
                finally:
                    try:
                        wrapped.unwrap()
                    except (OSError, ssl.SSLError):
                        pass
                    wrapped.close()
        finally:
            server.stop()


class TestPinnedContextRejectsDifferentCert:
    """TOCTOU window closed — if the server presents a different cert
    than the pinned DER, the wrap_socket override MUST reject."""

    def test_rejects_swapped_cert(self, cert_pair, attacker_cert_pair) -> None:
        _real_cert, _real_key, real_der = cert_pair
        evil_cert, evil_key, _evil_der = attacker_cert_pair

        # Real pin: the DER of the LEGITIMATE cert.
        # Server actually presents the ATTACKER cert (simulating MITM
        # that was successfully avoided by the pre-fetch but swapped in
        # for the actual request — the exact TOCTOU the old code had).
        server = _EchoTlsServer(evil_cert, evil_key)
        server.start()
        try:
            time.sleep(0.05)
            ctx = _PinnedToCertContext(real_der)
            with socket.create_connection(("127.0.0.1", server.port)) as raw:
                with pytest.raises(ssl.SSLCertVerificationError) as excinfo:
                    ctx.wrap_socket(raw, server_hostname="seed-test-real")
                msg = str(excinfo.value)
                expected_hex = hashlib.sha256(real_der).hexdigest()
                assert expected_hex in msg, msg
                assert "mismatch" in msg.lower(), msg
        finally:
            server.stop()


class TestBuildPinnedSslContextRoundTrip:
    """The public builder: pre-fetches the cert, verifies it matches,
    returns a pinned context ready to hand to httpx."""

    def test_matching_pin_returns_context(self, cert_pair) -> None:
        cert, key, der = cert_pair
        expected = hashlib.sha256(der).hexdigest()
        server = _EchoTlsServer(cert, key)
        server.start()
        try:
            time.sleep(0.05)
            ctx = build_pinned_ssl_context(
                expected_sha256=expected,
                host="127.0.0.1",
                port=server.port,
                timeout=5.0,
            )
            assert isinstance(ctx, _PinnedToCertContext)
        finally:
            server.stop()

    def test_mismatched_pin_raises_tls_pin_error(self, cert_pair) -> None:
        cert, key, _der = cert_pair
        # Deliberately wrong expected hex — 64 chars, all zeros.
        wrong = "0" * 64
        server = _EchoTlsServer(cert, key)
        server.start()
        try:
            time.sleep(0.05)
            with pytest.raises(TlsPinError) as excinfo:
                build_pinned_ssl_context(
                    expected_sha256=wrong,
                    host="127.0.0.1",
                    port=server.port,
                    timeout=5.0,
                )
            assert excinfo.value.expected == wrong
            assert excinfo.value.actual is not None
            assert excinfo.value.actual != wrong
        finally:
            server.stop()

    def test_unreachable_host_raises_tls_pin_error(self) -> None:
        # Closed port at loopback — ssl.get_server_certificate raises
        # ConnectionRefusedError which must surface as TlsPinError.
        # Pick a random high port likely unused.
        with pytest.raises(TlsPinError) as excinfo:
            build_pinned_ssl_context(
                expected_sha256="a" * 64,
                host="127.0.0.1",
                port=1,  # port 1 is reserved / unused locally
                timeout=1.0,
            )
        assert excinfo.value.actual is None
        assert "fetch failed" in str(excinfo.value).lower()
