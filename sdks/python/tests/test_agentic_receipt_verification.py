"""Tests for ``cognitum.agentic.receipt_verification`` (issue #56).

Mirrors the Node/Rust suites for the same module: build a valid receipt and
verify it passes; tamper with it and verify rejection; confirm a shape-only
receipt correctly skips cryptographic checks it never claimed; and validate
lineage-chain structural checks (broken link, cycle, non-increasing
sequence, and the genesis-only single-entry edge case).
"""

from __future__ import annotations

import hashlib
import hmac as hmac_lib

from cognitum.agentic.receipt_verification import (
    VerifyLineageChainOptions,
    VerifyReceiptOptions,
    build_execution_receipt,
    canonical_json,
    verify_execution_receipt,
    verify_lineage_chain,
)
from cognitum.agentic.receipts import LineageReference, LineageSubject, VerificationResult

KEY = b"test-signing-key"


def resolve_key(issuer: str, key_id: str) -> bytes | None:
    return KEY if issuer == "cognitum-one" and key_id == "key-1" else None


def sign(canonical_bytes: str) -> str:
    return hmac_lib.new(KEY, canonical_bytes.encode("utf-8"), hashlib.sha256).hexdigest()


def make_receipt(**overrides):
    params = {
        "receipt_id": "rcpt_1",
        "product": "harnessaas",
        "contract_version": "1.0",
        "request_id": "req_1",
        "operation_id": "op_1",
        "started_at": "2026-07-18T00:00:00.000Z",
        "completed_at": "2026-07-18T00:00:05.000Z",
        "outcome": "succeeded",
        "costs": [
            {"source": "provider", "amount": 0.01, "currency": "USD", "finality": "estimate"}
        ],
        "issuer": "cognitum-one",
        "key_id": "key-1",
        "sign": sign,
    }
    params.update(overrides)
    from cognitum.agentic.receipts import CostObservation

    params["costs"] = [CostObservation(**c) if isinstance(c, dict) else c for c in params["costs"]]
    return build_execution_receipt(**params)


def test_build_produces_shape_valid_receipt():
    receipt = make_receipt()
    assert receipt.schema == "cognitum.execution-receipt.v1"
    assert receipt.subject.request_id == "req_1"
    assert receipt.verification.level == "shape"
    assert receipt.verification.valid is True
    assert receipt.canonicalization == "cognitum-canonical-json-v1"


def test_build_flags_structurally_incomplete_receipt():
    receipt = make_receipt(outcome="")
    assert receipt.verification.level == "none"
    assert receipt.verification.valid is False
    assert "outcome" in receipt.verification.failure


def test_verify_reaches_cryptographic_for_a_valid_signed_receipt():
    receipt = make_receipt()
    result = verify_execution_receipt(
        receipt, VerifyReceiptOptions(min_level="cryptographic", resolve_key=resolve_key)
    )
    assert result.valid is True
    assert result.level == "cryptographic"
    assert result.algorithm == "hmac-sha256"


def test_verify_rejects_a_receipt_with_a_tampered_signature():
    from dataclasses import replace

    receipt = make_receipt()
    tampered = replace(receipt, outcome="failed")
    result = verify_execution_receipt(
        tampered, VerifyReceiptOptions(min_level="cryptographic", resolve_key=resolve_key)
    )
    assert result.valid is False
    assert result.level == "none"
    assert "signature" in result.failure


def test_verify_rejects_tampered_costs_post_signing():
    from dataclasses import replace

    from cognitum.agentic.receipts import CostObservation

    receipt = make_receipt()
    tampered = replace(
        receipt,
        costs=[CostObservation(source="provider", amount=999, currency="USD", finality="estimate")],
    )
    result = verify_execution_receipt(
        tampered, VerifyReceiptOptions(min_level="digest", resolve_key=resolve_key)
    )
    assert result.valid is False


def test_shape_only_receipt_skips_crypto_checks_it_never_claimed():
    receipt = build_execution_receipt(
        receipt_id="rcpt_2",
        product="meta-llm",
        contract_version="1.0",
        request_id="req_2",
        started_at="2026-07-18T00:00:00.000Z",
        outcome="succeeded",
    )
    assert receipt.signature is None

    result = verify_execution_receipt(receipt, VerifyReceiptOptions(min_level="shape"))
    assert result.valid is True
    assert result.level == "shape"

    strict = verify_execution_receipt(receipt, VerifyReceiptOptions(min_level="cryptographic"))
    assert strict.valid is False
    assert "receipt carries no signature/issuer/keyId claim" in strict.warnings


def test_achieves_digest_level_with_matching_expected_digest():
    from dataclasses import asdict

    from cognitum.agentic.receipt_verification import sha256_hex

    receipt = build_execution_receipt(
        receipt_id="rcpt_3",
        product="meta-proxy",
        contract_version="1.0",
        request_id="req_3",
        started_at="2026-07-18T00:00:00.000Z",
        outcome="succeeded",
    )
    signable = asdict(receipt)
    signable.pop("signature", None)
    signable.pop("verification", None)
    digest = sha256_hex(canonical_json(signable))
    result = verify_execution_receipt(
        receipt, VerifyReceiptOptions(min_level="digest", expected_digest=digest)
    )
    assert result.valid is True
    assert result.level == "digest"


def make_chain() -> list[LineageReference]:
    def entry(i: int, prev_root: str | None = None) -> LineageReference:
        return LineageReference(
            subject=LineageSubject(request_id="req_1"),
            leaf=f"leaf-{i}",
            root=f"root-{i}",
            sequence=i,
            previous_checkpoint=prev_root,
            checkpoint_time="2026-07-18T00:00:00.000Z",
            verification=VerificationResult(
                level="none", valid=False, checked_at="2026-07-18T00:00:00.000Z"
            ),
        )

    return [entry(0), entry(1, "root-0"), entry(2, "root-1")]


def test_accepts_a_well_formed_chain():
    result = verify_lineage_chain(make_chain(), VerifyLineageChainOptions(min_level="digest"))
    assert result.valid is True
    assert len(result.results) == 3


def test_rejects_a_chain_with_a_broken_link():
    from dataclasses import replace

    chain = make_chain()
    chain[2] = replace(chain[2], previous_checkpoint="root-999")
    result = verify_lineage_chain(chain, VerifyLineageChainOptions(min_level="digest"))
    assert result.valid is False
    assert result.broken_at_index == 2
    assert "previousCheckpoint" in result.failure


def test_rejects_a_chain_containing_a_cycle():
    from dataclasses import replace

    chain = make_chain()
    chain[2] = replace(chain[2], root="root-0")
    result = verify_lineage_chain(chain, VerifyLineageChainOptions(min_level="shape"))
    assert result.valid is False
    assert "cycle" in result.failure


def test_rejects_a_chain_whose_sequence_does_not_strictly_increase():
    from dataclasses import replace

    chain = make_chain()
    chain[2] = replace(chain[2], sequence=1)
    result = verify_lineage_chain(chain, VerifyLineageChainOptions(min_level="shape"))
    assert result.valid is False
    assert "sequence" in result.failure


def test_single_entry_genesis_only_chain_achieves_only_shape():
    chain = [make_chain()[0]]
    shape_result = verify_lineage_chain(chain, VerifyLineageChainOptions(min_level="shape"))
    assert shape_result.valid is True
    assert shape_result.level == "shape"

    strict = verify_lineage_chain(chain, VerifyLineageChainOptions(min_level="digest"))
    assert strict.valid is False
