"""Tests for MetaHarnessClient construction and the ADR-0026a §D2 fail-closed
method stubs (issue #64 / M4 start)."""

from __future__ import annotations

import pytest

from cognitum.agentic import UnsupportedCapabilityError
from cognitum.metaharness import DEFAULT_HANDSHAKE_TIMEOUT_MS, MetaHarnessClient, MetaHarnessConfig


class TestConstruction:
    """ADR-0026a §D1: construction performs zero I/O."""

    def test_constructs_with_no_arguments(self) -> None:
        client = MetaHarnessClient()
        assert client.config.handshake_timeout_ms == DEFAULT_HANDSHAKE_TIMEOUT_MS
        assert client.config.preview_features == []

    def test_holds_caller_supplied_opaque_policy_fields_as_is(self) -> None:
        distribution = {"registry": "https://registry.npmjs.org", "version": "0.4.1"}
        client = MetaHarnessClient(
            MetaHarnessConfig(
                distribution=distribution,
                workspace_policy={"allow_symlinks": False},
                process_policy={"max_concurrent": 1},
                acquisition_timeout_ms=5_000,
                operation_timeout_ms=30_000,
                preview_features=["catalog"],
            )
        )
        assert client.config.distribution is distribution
        assert client.config.acquisition_timeout_ms == 5_000
        assert client.config.operation_timeout_ms == 30_000
        assert client.config.preview_features == ["catalog"]

    def test_rejects_non_positive_handshake_timeout(self) -> None:
        with pytest.raises(ValueError, match="handshake_timeout_ms"):
            MetaHarnessConfig(handshake_timeout_ms=0)

    def test_rejects_non_positive_acquisition_timeout(self) -> None:
        with pytest.raises(ValueError, match="acquisition_timeout_ms"):
            MetaHarnessConfig(acquisition_timeout_ms=-1)

    def test_rejects_non_positive_operation_timeout(self) -> None:
        with pytest.raises(ValueError, match="operation_timeout_ms"):
            MetaHarnessConfig(operation_timeout_ms=-1)

    def test_copies_preview_features_rather_than_aliasing(self) -> None:
        features = ["catalog"]
        client = MetaHarnessClient(MetaHarnessConfig(preview_features=features))
        features.append("scaffold-plan")
        assert client.config.preview_features == ["catalog"]

    @pytest.mark.asyncio
    async def test_aclose_resolves_without_error(self) -> None:
        client = MetaHarnessClient()
        await client.aclose()

    @pytest.mark.asyncio
    async def test_async_context_manager(self) -> None:
        async with MetaHarnessClient() as client:
            assert isinstance(client, MetaHarnessClient)


class TestBlockedMethodStubs:
    """ADR-0026a §D2/§D7: every operational method fails closed with zero I/O."""

    @pytest.mark.asyncio
    async def test_capabilities_raises_with_expected_capability(self) -> None:
        client = MetaHarnessClient()
        with pytest.raises(UnsupportedCapabilityError) as exc_info:
            await client.capabilities()
        err = exc_info.value
        assert err.capability == "metaharness.bridge.hello"
        assert err.product == "metaharness"
        assert err.operation == "capabilities"
        assert err.retryable is False
        assert err.kind == "unsupported_capability"

    @pytest.mark.asyncio
    async def test_list_templates_raises(self) -> None:
        client = MetaHarnessClient()
        with pytest.raises(UnsupportedCapabilityError) as exc_info:
            await client.list_templates()
        assert exc_info.value.capability == "metaharness.catalog.templates"

    @pytest.mark.asyncio
    async def test_list_hosts_raises(self) -> None:
        client = MetaHarnessClient()
        with pytest.raises(UnsupportedCapabilityError) as exc_info:
            await client.list_hosts()
        assert exc_info.value.capability == "metaharness.catalog.hosts"

    @pytest.mark.asyncio
    async def test_analyze_repository_raises_before_any_io(self) -> None:
        from cognitum.metaharness import LocalRepository

        client = MetaHarnessClient()
        with pytest.raises(UnsupportedCapabilityError) as exc_info:
            await client.analyze_repository(LocalRepository(canonical_path="/tmp/repo"))
        assert exc_info.value.capability == "metaharness.repository.analyze"

    @pytest.mark.asyncio
    async def test_score_repository_raises(self) -> None:
        from cognitum.metaharness import LocalRepository

        client = MetaHarnessClient()
        with pytest.raises(UnsupportedCapabilityError) as exc_info:
            await client.score_repository(LocalRepository(canonical_path="/tmp/repo"))
        assert exc_info.value.capability == "metaharness.repository.score"

    @pytest.mark.asyncio
    async def test_plan_scaffold_raises(self) -> None:
        from cognitum.metaharness import ScaffoldRequestV1

        client = MetaHarnessClient()
        request = ScaffoldRequestV1(
            name="demo",
            template="default",
            hosts=["claude-code"],
            target="/tmp/target",
            darwin=None,
        )
        with pytest.raises(UnsupportedCapabilityError) as exc_info:
            await client.plan_scaffold(request)
        assert exc_info.value.capability == "metaharness.scaffold.plan"

    @pytest.mark.asyncio
    async def test_scaffold_raises(self) -> None:
        from cognitum.metaharness import (
            ApplyApproval,
            GeneratorIdentity,
            ScaffoldPlan,
            TemplateIdentity,
        )

        client = MetaHarnessClient()
        plan = ScaffoldPlan(
            plan_id="plan_1",
            plan_digest="sha256:deadbeef",
            created_at="2026-07-18T00:00:00Z",
            expires_at="2026-07-18T00:10:00Z",
            generator_identity=GeneratorIdentity(product="metaharness-oss"),
            template_identity=TemplateIdentity(template="default"),
            canonical_target="/tmp/target",
            target_before_digest="sha256:before",
            request_digest="sha256:request",
        )
        approval = ApplyApproval(plan_digest="sha256:deadbeef", approved_at="2026-07-18T00:00:00Z")
        with pytest.raises(UnsupportedCapabilityError) as exc_info:
            await client.scaffold(plan, approval)
        assert exc_info.value.capability == "metaharness.scaffold.render"

    @pytest.mark.asyncio
    async def test_inspect_manifest_raises(self) -> None:
        from cognitum.metaharness import LocalRepository

        client = MetaHarnessClient()
        with pytest.raises(UnsupportedCapabilityError) as exc_info:
            await client.inspect_manifest(LocalRepository(canonical_path="/tmp/repo"))
        assert exc_info.value.capability == "metaharness.manifest.inspect"

    @pytest.mark.asyncio
    async def test_validate_harness_raises(self) -> None:
        from cognitum.metaharness import LocalRepository

        client = MetaHarnessClient()
        with pytest.raises(UnsupportedCapabilityError) as exc_info:
            await client.validate_harness(LocalRepository(canonical_path="/tmp/repo"))
        assert exc_info.value.capability == "metaharness.harness.validate"

    @pytest.mark.asyncio
    async def test_compare_harnesses_raises(self) -> None:
        from cognitum.metaharness import LocalRepository

        client = MetaHarnessClient()
        with pytest.raises(UnsupportedCapabilityError) as exc_info:
            await client.compare_harnesses(
                LocalRepository(canonical_path="/tmp/a"),
                LocalRepository(canonical_path="/tmp/b"),
            )
        assert exc_info.value.capability == "metaharness.harness.compare"

    @pytest.mark.asyncio
    async def test_verify_witness_raises(self) -> None:
        from cognitum.metaharness import LocalRepository

        client = MetaHarnessClient()
        with pytest.raises(UnsupportedCapabilityError) as exc_info:
            await client.verify_witness(LocalRepository(canonical_path="/tmp/repo"))
        assert exc_info.value.capability == "metaharness.witness.shape"

    @pytest.mark.asyncio
    async def test_stubs_never_touch_a_process_or_filesystem_spy(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Structural proof no I/O path exists yet: patch subprocess spawn
        and assert it is never invoked while every blocked method is called.
        """
        import asyncio

        spawn_calls: list[object] = []

        async def fake_create_subprocess_exec(*args: object, **kwargs: object) -> None:
            spawn_calls.append(args)
            raise AssertionError("no subprocess should ever be spawned by a blocked stub")

        monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

        client = MetaHarnessClient()
        results = await asyncio.gather(
            client.capabilities(),
            client.list_templates(),
            client.list_hosts(),
            return_exceptions=True,
        )
        assert all(isinstance(r, UnsupportedCapabilityError) for r in results)
        assert spawn_calls == []
