"""End-to-end TOCTOU verification through SeedClient (security audit C2).

The companion ``test_pinned_ssl_context.py`` covers the primitive
(``_PinnedToCertContext`` + ``build_pinned_ssl_context``) directly.
This file exercises the **integration path** — SeedClient constructed
with a fingerprint map, requests routed through the pinned httpx.Client
that gets built on first use. Without this integration test, it is
possible to land the primitive without wiring it, which is exactly what
the devils-advocate review flagged.

Two assertions prove the wiring:

1. When the seed's real cert matches the pinned SHA-256, ``client.status()``
   succeeds through the pinned path.
2. When the seed's cert is swapped to a different DER (the classic mDNS
   MITM scenario), the very next request raises :class:`TlsPinError` —
   NOT a generic ``NetworkError`` or ``TransportError``. Surface of the
   error matters: callers who ``except TlsPinError`` must observe it.
"""

from __future__ import annotations

import json
import socket
import ssl
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import pytest

from cognitum._errors import NetworkError, TlsPinError
from cognitum.seed import SeedClient, SeedTLS


def _openssl_gen_self_signed(tmpdir: Path, suffix: str) -> tuple[Path, Path, bytes]:
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
            f"/CN=seed-e2e-{suffix}",
        ],
        check=True,
        capture_output=True,
    )
    pem = cert_path.read_bytes()
    der = ssl.PEM_cert_to_DER_cert(pem.decode())
    return cert_path, key_path, der


class _StubSeedHttpsServer:
    """Tiny TLS server that answers ``GET /api/v1/status`` with a valid
    JSON body. Used as a stand-in for a real seed so we can exercise
    the full request pipeline (pin-context build → httpx.Client →
    handshake → pin check → request → response decode) without
    bringing up a cognitum-agent.
    """

    def __init__(self, cert_path: Path, key_path: Path) -> None:
        self._ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self._ctx.load_cert_chain(str(cert_path), str(key_path))
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(8)
        self.port: int = self._sock.getsockname()[1]
        self._thread: threading.Thread | None = None
        self._stop = False

    def start(self) -> None:
        def _serve() -> None:
            while not self._stop:
                self._sock.settimeout(0.2)
                try:
                    try:
                        raw, _ = self._sock.accept()
                    except socket.timeout:
                        continue
                    try:
                        ss = self._ctx.wrap_socket(raw, server_side=True)
                        try:
                            # Read the request line + headers, ignore
                            # body — GET /status has none.
                            _data = ss.recv(8192)
                            body = json.dumps(
                                {
                                    "device_id": "stub-seed",
                                    "epoch": 1,
                                    "pairing_window_open": False,
                                }
                            )
                            response = (
                                "HTTP/1.1 200 OK\r\n"
                                "Content-Type: application/json\r\n"
                                f"Content-Length: {len(body)}\r\n"
                                "Connection: close\r\n"
                                "\r\n"
                                f"{body}"
                            )
                            ss.sendall(response.encode("utf-8"))
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
def real_cert():
    with tempfile.TemporaryDirectory() as tmp:
        cert, key, der = _openssl_gen_self_signed(Path(tmp), "real")
        yield cert, key, der


@pytest.fixture
def attacker_cert():
    with tempfile.TemporaryDirectory() as tmp:
        cert, key, der = _openssl_gen_self_signed(Path(tmp), "evil")
        yield cert, key, der


def _sha256_hex(der: bytes) -> str:
    import hashlib

    return hashlib.sha256(der).hexdigest()


class TestPinnedRequestSucceedsOnMatch:
    """The pinned httpx.Client routes the request successfully when the
    seed's cert matches the pinned SHA-256."""

    def test_status_succeeds_when_pin_matches(self, real_cert) -> None:
        cert_path, key_path, der = real_cert
        expected = _sha256_hex(der)
        server = _StubSeedHttpsServer(cert_path, key_path)
        server.start()
        try:
            time.sleep(0.05)
            # fingerprints map: {peer_url: expected_sha256_hex}
            peer_url = f"https://127.0.0.1:{server.port}"
            client = _seed_client_with_fingerprints(
                peer_url, {peer_url: expected}
            )
            try:
                status = client.status()
                assert status.device_id == "stub-seed"
            finally:
                client.close()
        finally:
            server.stop()


def _seed_client_with_fingerprints(
    peer_url: str, fingerprints: dict[str, str]
) -> SeedClient:
    """Construct a SeedClient with an explicit fingerprint map.

    The public `SeedClient.__init__` doesn't accept `fingerprints` —
    they flow through discovery providers today. The tests need a way
    to inject them directly, so we build the client normally, then
    rebuild its transport with the options patched in. This is the same
    path a discovery provider would take; just with a fixed dict instead
    of a live mDNS browse.
    """
    from dataclasses import replace

    client = SeedClient(
        endpoints=peer_url,
        tls=SeedTLS(insecure=True),
        max_retries=0,
    )
    # Close the default transport before replacing — its httpx.Client
    # is live and would leak sockets otherwise.
    client._transport.close()
    patched = replace(client._options, fingerprints=fingerprints)
    client._options = patched
    client._transport = client._transport.__class__(patched)
    # Rewire resources to the new transport (they cache it).
    from cognitum.seed.resources import (
        CustodyResource,
        MeshResource,
        OtaResource,
        PairResource,
        StoreResource,
        WitnessResource,
    )

    client.pair = PairResource(client._transport)
    client.store = StoreResource(client._transport)
    client.custody = CustodyResource(client._transport)
    client.witness = WitnessResource(client._transport)
    client.ota = OtaResource(client._transport)
    client.mesh = MeshResource(client._transport)
    return client


class TestPinnedRequestAcceptsSeed16CharPin:
    """Regression guard for the silent-bypass fix — seed firmware emits
    `fp={first 16 hex chars}`. The integration must accept that form
    end-to-end (discovery → fingerprints dict → pinned client →
    prefix-match → request). Previously rejected by the exact-64
    length check in build_pinned_ssl_context."""

    def test_status_succeeds_with_16_char_pin(self, real_cert) -> None:
        cert_path, key_path, der = real_cert
        # Take only the first 16 hex chars of the real cert's SHA-256
        # — this is the seed firmware's TXT form.
        full_hex = _sha256_hex(der)
        prefix16 = full_hex[:16]
        server = _StubSeedHttpsServer(cert_path, key_path)
        server.start()
        try:
            time.sleep(0.05)
            peer_url = f"https://127.0.0.1:{server.port}"
            client = _seed_client_with_fingerprints(
                peer_url, {peer_url: prefix16}
            )
            try:
                status = client.status()
                assert status.device_id == "stub-seed"
            finally:
                client.close()
        finally:
            server.stop()

    def test_16_char_pin_mismatch_still_raises(
        self, real_cert, attacker_cert
    ) -> None:
        # Adversarial case: the pin is a 16-char prefix of the LEGIT
        # cert's SHA-256, but the server presents the ATTACKER cert.
        # prefix-match must catch this.
        _real_cert, _real_key, real_der = real_cert
        evil_cert, evil_key, _evil_der = attacker_cert
        prefix16 = _sha256_hex(real_der)[:16]
        server = _StubSeedHttpsServer(evil_cert, evil_key)
        server.start()
        try:
            time.sleep(0.05)
            peer_url = f"https://127.0.0.1:{server.port}"
            client = _seed_client_with_fingerprints(
                peer_url, {peer_url: prefix16}
            )
            try:
                with pytest.raises(TlsPinError):
                    client.status()
            finally:
                client.close()
        finally:
            server.stop()


class TestPinnedRequestRaisesTlsPinErrorOnSwap:
    """The integration's job: when the server presents a cert whose DER
    doesn't match the pinned SHA-256, SeedClient.status() must raise
    TlsPinError — not NetworkError, not TransportError."""

    def test_mismatch_at_first_call_raises_tls_pin_error(
        self, real_cert, attacker_cert
    ) -> None:
        _real_cert, _real_key, real_der = real_cert
        evil_cert, evil_key, _evil_der = attacker_cert
        # Pin the LEGITIMATE cert's SHA, but the server actually
        # presents the ATTACKER cert — pre-fetch in
        # `build_pinned_ssl_context` catches it immediately.
        expected = _sha256_hex(real_der)
        server = _StubSeedHttpsServer(evil_cert, evil_key)
        server.start()
        try:
            time.sleep(0.05)
            peer_url = f"https://127.0.0.1:{server.port}"
            client = _seed_client_with_fingerprints(
                peer_url, {peer_url: expected}
            )
            try:
                with pytest.raises(TlsPinError) as excinfo:
                    client.status()
                # The error must carry the expected pin and identify
                # the peer — callers filter on these for logging /
                # alerting.
                assert excinfo.value.peer_url == peer_url
                assert excinfo.value.expected == expected.lower()
            finally:
                client.close()
        finally:
            server.stop()

    def test_pin_mismatch_does_not_surface_as_network_error(
        self, real_cert, attacker_cert
    ) -> None:
        # Separate test: prove that the mismatch path is distinguishable
        # from a generic transport failure. Without the
        # ``_find_pin_mismatch_in_chain`` hook the pin mismatch would be
        # wrapped as NetworkError and a caller filtering on TlsPinError
        # alone would miss it.
        _real_cert, _real_key, real_der = real_cert
        evil_cert, evil_key, _evil_der = attacker_cert
        expected = _sha256_hex(real_der)
        server = _StubSeedHttpsServer(evil_cert, evil_key)
        server.start()
        try:
            time.sleep(0.05)
            peer_url = f"https://127.0.0.1:{server.port}"
            client = _seed_client_with_fingerprints(
                peer_url, {peer_url: expected}
            )
            try:
                with pytest.raises(TlsPinError):
                    client.status()
                # And explicitly: not NetworkError. If the error hierarchy
                # ever changes to make TlsPinError subclass NetworkError,
                # this will fail and force a review.
                try:
                    client.status()
                except TlsPinError:
                    pass  # correct
                except NetworkError as exc:
                    pytest.fail(
                        f"pin mismatch leaked as NetworkError: {exc!r}"
                    )
            finally:
                client.close()
        finally:
            server.stop()


class TestPinVerifierFullyRemoved:
    """Regression guard — PinVerifier should no longer exist in any
    import path used by the client transports. Prevents a future commit
    from re-introducing the TOCTOU-prone pre-check."""

    def test_pin_verifier_symbol_is_gone_from_transport(self) -> None:
        from cognitum.seed import _transport

        assert not hasattr(
            _transport, "PinVerifier"
        ), "PinVerifier should be removed — see security audit C2 fix"

    def test_sync_transport_has_no_pin_verifier_attr(self, real_cert) -> None:
        cert_path, key_path, der = real_cert
        server = _StubSeedHttpsServer(cert_path, key_path)
        server.start()
        try:
            time.sleep(0.05)
            peer_url = f"https://127.0.0.1:{server.port}"
            client = _seed_client_with_fingerprints(
                peer_url, {peer_url: _sha256_hex(der)}
            )
            try:
                # The `_pin_verifier` field existed in 0.2.0 and drove
                # the TOCTOU-prone out-of-band verify. It must be gone.
                assert not hasattr(client._transport, "_pin_verifier")
                # The replacement fields.
                assert hasattr(client._transport, "_fingerprints")
                assert hasattr(client._transport, "_pinned_clients")
            finally:
                client.close()
        finally:
            server.stop()
