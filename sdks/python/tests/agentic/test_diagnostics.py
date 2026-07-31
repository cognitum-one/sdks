"""Tests for the D10 diagnostic-capture policy/manifest scaffolding
(ADR-0028 D10, lines 325-343).

Covers:

- ``preview_diagnostic_manifest`` computes ``would_capture`` as the
  intersection of allowed categories minus the hard-coded
  never-capturable set, for several policy combinations;
- the hard block wins even when a policy explicitly tries to allow
  ``"credentials"``/``"signed-urls"`` (the single most important test);
- ``blocked_by_policy`` correctly lists categories not in
  ``allowed_categories``, distinct from the hard-blocked ones;
- ``DiagnosticPolicy``/``DiagnosticManifest``/``DiagnosticBundle`` shapes
  are usable and their fields round-trip via ``dataclasses.asdict``.
"""

from __future__ import annotations

from dataclasses import asdict

from cognitum.agentic.diagnostics import (
    D10_RELEVANT_CATEGORIES,
    NEVER_CAPTURABLE_CATEGORIES,
    DiagnosticBundle,
    DiagnosticManifest,
    DiagnosticPolicy,
    DiagnosticSink,
    RedactionReport,
    RetentionPolicy,
    is_never_capturable,
    preview_diagnostic_manifest,
)
from cognitum.agentic.sentinel import D12Category


def _policy_with_allowed(allowed: list[D12Category]) -> DiagnosticPolicy:
    return DiagnosticPolicy(
        max_bytes=1_048_576,
        max_duration_ms=5_000,
        sink=DiagnosticSink(kind="local_path", path="/tmp/diagnostics"),
        encryption_required=True,
        retention=RetentionPolicy(max_age_ms=86_400_000),
        included_fields=["field.example"],
        access_expectation="operator-only",
        allowed_categories=set(allowed),
    )


def test_d10_relevant_categories_has_six_unique_categories_excluding_hard_blocked() -> None:
    assert len(D10_RELEVANT_CATEGORIES) == 6
    assert len(set(D10_RELEVANT_CATEGORIES)) == 6
    for blocked in NEVER_CAPTURABLE_CATEGORIES:
        assert blocked not in D10_RELEVANT_CATEGORIES


def test_all_six_relevant_categories_allowed_yields_full_would_capture() -> None:
    policy = _policy_with_allowed(list(D10_RELEVANT_CATEGORIES))
    manifest = preview_diagnostic_manifest(policy)
    assert len(manifest.would_capture) == 6
    for category in D10_RELEVANT_CATEGORIES:
        assert category in manifest.would_capture
    assert manifest.blocked_by_policy == []


def test_only_some_categories_allowed_splits_would_capture_and_blocked() -> None:
    policy = _policy_with_allowed(["prompts", "environment-values"])
    manifest = preview_diagnostic_manifest(policy)
    assert set(manifest.would_capture) == {"prompts", "environment-values"}
    assert set(manifest.blocked_by_policy) == {
        "messages",
        "source",
        "patches",
        "tool-arguments-results",
    }
    assert "environment-values" not in manifest.blocked_by_policy
    assert len(manifest.would_capture) + len(manifest.blocked_by_policy) == 6


def test_empty_allowed_categories_blocks_everything() -> None:
    policy = _policy_with_allowed([])
    manifest = preview_diagnostic_manifest(policy)
    assert manifest.would_capture == []
    assert len(manifest.blocked_by_policy) == 6


def test_hard_block_wins_even_when_policy_explicitly_allows_credentials_and_signed_urls() -> None:
    # The single most important test in this module: a policy that tries
    # to "allow" credentials/signed-urls (plus every D10-relevant
    # category, so the hard block is the only thing that could exclude
    # them) must never see them show up in would_capture. The hard block
    # is policy-independent, per ADR-0028 D10.
    allowed = [*D10_RELEVANT_CATEGORIES, "credentials", "signed-urls"]
    policy = _policy_with_allowed(allowed)

    assert "credentials" in policy.allowed_categories
    assert "signed-urls" in policy.allowed_categories

    manifest = preview_diagnostic_manifest(policy)
    assert "credentials" not in manifest.would_capture
    assert "signed-urls" not in manifest.would_capture
    assert "credentials" not in manifest.blocked_by_policy
    assert "signed-urls" not in manifest.blocked_by_policy
    assert len(manifest.would_capture) == 6


def test_is_never_capturable_covers_exactly_credentials_and_signed_urls() -> None:
    assert is_never_capturable("credentials") is True
    assert is_never_capturable("signed-urls") is True
    for category in D10_RELEVANT_CATEGORIES:
        assert is_never_capturable(category) is False
    assert is_never_capturable("webhook-bodies") is False
    assert is_never_capturable("repository-urls") is False
    assert is_never_capturable("raw-tenant-user-identifiers") is False


def test_diagnostic_policy_fields_are_accessible_and_asdict_round_trips() -> None:
    policy = _policy_with_allowed(["prompts", "source"])
    as_dict = asdict(policy)
    assert as_dict["max_bytes"] == 1_048_576
    assert as_dict["sink"] == {"kind": "local_path", "path": "/tmp/diagnostics"}
    assert as_dict["retention"] == {"max_age_ms": 86_400_000}
    assert as_dict["included_fields"] == ["field.example"]
    assert as_dict["allowed_categories"] == {"prompts", "source"}


def test_diagnostic_sink_callback_variant_has_no_path() -> None:
    sink = DiagnosticSink(kind="callback")
    assert sink.path is None
    assert asdict(sink) == {"kind": "callback", "path": None}


def test_diagnostic_manifest_asdict_round_trips() -> None:
    manifest = DiagnosticManifest(would_capture=["prompts"], blocked_by_policy=["source"])
    assert asdict(manifest) == {
        "would_capture": ["prompts"],
        "blocked_by_policy": ["source"],
    }


def test_diagnostic_bundle_asdict_round_trips() -> None:
    bundle = DiagnosticBundle(
        redaction_report=RedactionReport(
            redaction_count=3,
            categories_redacted=["credentials", "prompts"],
        ),
        sdk_version="0.1.0",
        contract_version="1.0",
        sha256_digest="a" * 64,
    )
    as_dict = asdict(bundle)
    assert as_dict["redaction_report"]["redaction_count"] == 3
    assert as_dict["sdk_version"] == "0.1.0"
    assert as_dict["contract_version"] == "1.0"
    assert as_dict["sha256_digest"] == "a" * 64
