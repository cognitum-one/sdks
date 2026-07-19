"""Tests for MetaHarness domain types (ADR-0026a §D3) -- schema literals,
tagged-union round-trips, and unknown-field/unknown-enum preservation."""

from __future__ import annotations

import copy
import json
from dataclasses import asdict

from cognitum.metaharness import (
    SCAFFOLD_PLAN_SCHEMA_V1,
    SCAFFOLD_REQUEST_SCHEMA_V1,
    SCAFFOLD_RESULT_SCHEMA_V1,
    FileAction,
    GeneratorIdentity,
    GitRepository,
    LocalRepository,
    ScaffoldPlan,
    ScaffoldRequestV1,
    TemplateIdentity,
    parse_harness_manifest,
    parse_witness_verification,
)


class TestSchemaLiterals:
    def test_exact_schema_string_literals(self) -> None:
        assert SCAFFOLD_REQUEST_SCHEMA_V1 == "cognitum.metaharness.scaffold-request.v1"
        assert SCAFFOLD_PLAN_SCHEMA_V1 == "cognitum.metaharness.scaffold-plan.v1"
        assert SCAFFOLD_RESULT_SCHEMA_V1 == "cognitum.metaharness.scaffold-result.v1"


class TestRepositorySourceRoundTrip:
    def test_local_repository_round_trips_through_json(self) -> None:
        source = LocalRepository(canonical_path="/tmp/repo", expected_tree_digest="sha256:abc123")
        round_tripped = json.loads(json.dumps(asdict(source)))
        assert round_tripped == asdict(source)
        assert round_tripped["kind"] == "local"

    def test_git_repository_round_trips_through_json(self) -> None:
        source = GitRepository(
            url="https://github.com/ruvnet/metaharness.git",
            requested_ref="main",
            resolved_commit_sha="072b95c0a74610de008dca5473343a81619cef20",
        )
        round_tripped = json.loads(json.dumps(asdict(source)))
        assert round_tripped == asdict(source)
        assert round_tripped["kind"] == "git"


class TestScaffoldRequestRoundTrip:
    def test_round_trips_with_exact_schema_literal(self) -> None:
        request = ScaffoldRequestV1(
            name="demo-harness",
            template="default",
            primary_host="claude-code",
            hosts=["claude-code", "codex"],
            description="a demo harness",
            target="/tmp/target",
            darwin=False,
            repository_source=LocalRepository(canonical_path="/tmp/repo"),
        )
        round_tripped = json.loads(json.dumps(asdict(request)))
        assert round_tripped == asdict(request)
        assert round_tripped["schema"] == "cognitum.metaharness.scaffold-request.v1"


class TestParseHarnessManifest:
    def test_parses_every_documented_field(self) -> None:
        wire = {
            "schema": "cognitum.metaharness.manifest.v1",
            "generator": "metaharness-oss",
            "template": "default",
            "template_version": "0.0.0",
            "vars": {"projectName": "demo"},
            "hosts": ["claude-code"],
            "files": ["CLAUDE.md", ".claude/settings.json"],
            "generated_at": "2026-07-18T00:00:00Z",
            "meta": {"note": "generated"},
        }
        manifest = parse_harness_manifest(wire)
        assert manifest.schema == "cognitum.metaharness.manifest.v1"
        assert manifest.generator == "metaharness-oss"
        assert manifest.template_version == "0.0.0"
        assert manifest.vars == {"projectName": "demo"}
        assert manifest.hosts == ["claude-code"]
        assert manifest.files == ["CLAUDE.md", ".claude/settings.json"]
        assert manifest.generated_at == "2026-07-18T00:00:00Z"
        assert manifest.meta == {"note": "generated"}
        assert manifest.raw is None

    def test_preserves_unknown_additive_fields_verbatim(self) -> None:
        wire = {
            "schema": "cognitum.metaharness.manifest.v1",
            "generator": "metaharness-oss",
            "template": "default",
            "template_version": "0.0.0",
            "vars": {},
            "hosts": [],
            "files": [],
            "generated_at": "2026-07-18T00:00:00Z",
            "signing_key_id": "kid-123",
            "extension_block": {"future": True},
        }
        manifest = parse_harness_manifest(wire)
        assert manifest.raw == {
            "signing_key_id": "kid-123",
            "extension_block": {"future": True},
        }


class TestParseWitnessVerification:
    def test_parses_shape_level_verification(self) -> None:
        wire = {
            "verification": {
                "level": "shape",
                "valid": True,
                "checked_at": "2026-07-18T00:00:00Z",
            },
            "witness_schema": "metaharness.witness.v1",
            "manifest_digest": "sha256:deadbeef",
            "entry_digests": ["sha256:aaa", "sha256:bbb"],
        }
        result = parse_witness_verification(wire)
        assert result.verification.level == "shape"
        assert result.verification.valid is True
        assert result.witness_schema == "metaharness.witness.v1"
        assert result.manifest_digest == "sha256:deadbeef"
        assert result.entry_digests == ["sha256:aaa", "sha256:bbb"]

    def test_shape_level_is_never_silently_escalated(self) -> None:
        wire = {
            "verification": {
                "level": "shape",
                "valid": True,
                "checked_at": "2026-07-18T00:00:00Z",
            }
        }
        result = parse_witness_verification(wire)
        assert result.verification.level == "shape"
        assert result.verification.level != "cryptographic"
        assert result.verification.level != "anchored"

    def test_fails_closed_on_unrecognized_verification_level(self) -> None:
        wire = {
            "verification": {
                "level": "MetaHarness-ADR-011-alternate-shape",
                "valid": True,
                "checked_at": "2026-07-18T00:00:00Z",
            }
        }
        result = parse_witness_verification(wire)
        assert result.verification.level == "none"
        assert result.verification.valid is False
        assert result.verification.warnings is not None
        assert "unknown verification level" in result.verification.warnings[0].lower()

    def test_preserves_unknown_top_level_fields_verbatim(self) -> None:
        wire = {
            "verification": {
                "level": "digest",
                "valid": True,
                "checked_at": "2026-07-18T00:00:00Z",
            },
            "future_witness_extension": {"anchor_proof": "opaque-blob"},
        }
        result = parse_witness_verification(wire)
        assert result.raw_unknown == {"future_witness_extension": {"anchor_proof": "opaque-blob"}}


class TestScaffoldPlanRoundTrip:
    def test_round_trips_full_plan_through_json(self) -> None:
        plan = ScaffoldPlan(
            plan_id="plan_1",
            plan_digest="sha256:plandigest",
            created_at="2026-07-18T00:00:00Z",
            expires_at="2026-07-18T00:10:00Z",
            generator_identity=GeneratorIdentity(
                product="metaharness-oss", package_version="0.4.1"
            ),
            template_identity=TemplateIdentity(
                template="default", template_version="0.0.0"
            ),
            canonical_target="/tmp/target",
            target_before_digest="sha256:before",
            request_digest="sha256:request",
            actions=[FileAction(kind="create", path="CLAUDE.md")],
            unresolved_variables=["projectName"],
            warnings=["template pins metaharness@0.1.5, a stale version"],
            destructive=False,
            estimated_files=1,
            estimated_bytes=128,
        )
        original = copy.deepcopy(asdict(plan))
        round_tripped = json.loads(json.dumps(asdict(plan)))
        assert round_tripped == original
        assert round_tripped["unresolved_variables"] == ["projectName"]
        assert round_tripped["schema"] == "cognitum.metaharness.scaffold-plan.v1"
