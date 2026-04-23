"""Unit tests for per-peer TLS fingerprint pinning (ADR-0007 §TLS).

Spins up an in-process HTTPS server with a self-signed cert, derives
the expected SHA-256 fingerprint, and drives :class:`SeedClient`
through the four precedence cases called out in the fp-pin ticket:

1. matching fp → success
2. mismatched fp → :class:`TlsPinError`
3. no fp + ``insecure=True`` → success (legacy path)
4. mismatched fp + ``insecure=True`` → STILL :class:`TlsPinError`
   (pin always wins over insecure — no fallback, ADR-0007 §TLS)

The server uses an ephemeral port and a freshly-generated key so the
digest is recomputed per test run.
"""

from __future__ import annotations

import hashlib
import ssl
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from cognitum._errors import TlsPinError
from cognitum.seed import SeedClient, SeedTLS
from cognitum.seed.discovery._types import DiscoveredPeer, DiscoveryProvider


# ---- fixture: self-signed HTTPS server in-process ------------------------


class _QuietHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 — stdlib API
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        payload = b'{"device_id":"dev-test","seed_version":"0.20.0"}'
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        return  # silence stderr


def _gen_self_signed(tmp_path: Path) -> tuple[Path, Path, str]:
    """Generate an ephemeral self-signed cert + key. Returns the DER
    SHA-256 hex digest alongside the paths."""
    # Prefer ``cryptography`` when available; fall back to shelling out
    # to ``openssl`` — both are present on the ruvultra venv.
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.x509.oid import NameOID
        import datetime as _dt

        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name(
            [x509.NameAttribute(NameOID.COMMON_NAME, "localhost")]
        )
        cert = (
            x509.CertificateBuilder()
            .subject_name(name)
            .issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(_dt.datetime.utcnow() - _dt.timedelta(days=1))
            .not_valid_after(_dt.datetime.utcnow() + _dt.timedelta(days=2))
            .add_extension(
                x509.SubjectAlternativeName(
                    [x509.DNSName("localhost"), x509.IPAddress(
                        __import__("ipaddress").ip_address("127.0.0.1")
                    )]
                ),
                critical=False,
            )
            .sign(key, hashes.SHA256())
        )
        cert_path = tmp_path / "cert.pem"
        key_path = tmp_path / "key.pem"
        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        key_path.write_bytes(
            key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )
        der = cert.public_bytes(serialization.Encoding.DER)
        fp = hashlib.sha256(der).hexdigest().lower()
        return cert_path, key_path, fp
    except ImportError:  # pragma: no cover — fallback for minimal venvs
        import subprocess

        cert_path = tmp_path / "cert.pem"
        key_path = tmp_path / "key.pem"
        subprocess.run(
            [
                "openssl", "req", "-x509", "-newkey", "ec",
                "-pkeyopt", "ec_paramgen_curve:P-256",
                "-nodes", "-keyout", str(key_path), "-out", str(cert_path),
                "-subj", "/CN=localhost",
                "-days", "2",
                "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
            ],
            check=True, capture_output=True,
        )
        pem = cert_path.read_bytes()
        der = ssl.PEM_cert_to_DER_cert(pem.decode())
        fp = hashlib.sha256(der).hexdigest().lower()
        return cert_path, key_path, fp


@pytest.fixture
def https_server(tmp_path: Path):
    cert_path, key_path, fingerprint = _gen_self_signed(tmp_path)

    httpd = HTTPServer(("127.0.0.1", 0), _QuietHandler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    host, port = httpd.server_address[0], httpd.server_address[1]
    url = f"https://{host}:{port}"

    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield url, fingerprint
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2)


# ---- fixture: discovery provider that surfaces a pinned peer -------------


class _StaticDiscovery:
    """Minimal :class:`DiscoveryProvider` that hands back one peer."""

    def __init__(self, peer: DiscoveredPeer) -> None:
        self._peer = peer

    def discover(self) -> list[DiscoveredPeer]:
        return [self._peer]

    async def adiscover(self) -> list[DiscoveredPeer]:
        return [self._peer]

    def close(self) -> None:
        return None


# ---- tests ---------------------------------------------------------------


def test_matching_fp_allows_request(https_server) -> None:
    url, fingerprint = https_server
    provider = _StaticDiscovery(
        DiscoveredPeer(url=url, tls_fingerprint=fingerprint)
    )
    assert isinstance(provider, DiscoveryProvider)

    with SeedClient(
        endpoints=provider,
        tls=SeedTLS(insecure=True),  # allow the actual handshake
        max_retries=0,
        max_elapsed_ms=2000,
    ) as client:
        # A successful call proves the pin check passed AND the HTTPS
        # handshake reached our local server.
        status = client.status()
        assert status.device_id == "dev-test"


def test_mismatched_fp_raises_tls_pin_error(https_server) -> None:
    url, _ = https_server
    wrong_fp = "00" * 32  # deliberately wrong, valid shape
    provider = _StaticDiscovery(
        DiscoveredPeer(url=url, tls_fingerprint=wrong_fp)
    )

    with SeedClient(
        endpoints=provider,
        tls=SeedTLS(insecure=True),
        max_retries=0,
        max_elapsed_ms=2000,
    ) as client:
        with pytest.raises(TlsPinError) as exc_info:
            client.status()
        err = exc_info.value
        assert err.peer_url == url
        assert err.expected == wrong_fp
        # Actual fingerprint is populated when the fetch succeeded.
        assert err.actual is not None and len(err.actual) == 64


def test_no_fp_with_insecure_true_succeeds(https_server) -> None:
    """No pinned fingerprint → the verifier no-ops; ``insecure=True``
    lets the handshake through as before."""
    url, _ = https_server
    provider = _StaticDiscovery(DiscoveredPeer(url=url))

    with SeedClient(
        endpoints=provider,
        tls=SeedTLS(insecure=True),
        max_retries=0,
        max_elapsed_ms=2000,
    ) as client:
        status = client.status()
        assert status.device_id == "dev-test"


def test_mismatched_fp_with_insecure_still_raises(https_server) -> None:
    """Pin mismatch MUST win over ``insecure=True`` — no fallback."""
    url, _ = https_server
    wrong_fp = "11" * 32
    provider = _StaticDiscovery(
        DiscoveredPeer(url=url, tls_fingerprint=wrong_fp)
    )

    with SeedClient(
        endpoints=provider,
        tls=SeedTLS(insecure=True),
        max_retries=0,
        max_elapsed_ms=2000,
    ) as client:
        with pytest.raises(TlsPinError):
            client.status()
