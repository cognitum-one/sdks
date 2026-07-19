"""Tests for RoutingIntent and the §D5 rule-7 decode-time receipt check
(issue #61 / M3 D5-D7)."""

from __future__ import annotations

import pytest

from cognitum.agentic import AgenticError
from cognitum.meta_proxy import (
    MetaProxyRoutingReceipt,
    RoutingIntent,
    assert_routing_receipt_matches_intent,
)


def _receipt(selected_plane: str) -> MetaProxyRoutingReceipt:
    return MetaProxyRoutingReceipt(
        request_id="rr_1",
        configured_plane="local",
        selected_plane=selected_plane,
        automatic=False,
        degraded=False,
    )


def test_routing_intent_defaults_are_neutral() -> None:
    intent = RoutingIntent()
    assert intent.required_plane is None
    assert intent.allowed_planes == []
    assert intent.workload_policy == "standard"
    assert intent.training_share is False
    assert intent.fail_if_unavailable is True


def test_no_intent_is_a_noop() -> None:
    # No intent => nothing to assert (the SDK runs no router of its own).
    # The only contract is "does not raise" -- assert_routing_receipt_matches_intent
    # returns None unconditionally, so calling it is the assertion itself; comparing
    # its result with `is None` is a pointless expression mypy correctly flags
    # (func-returns-value).
    assert_routing_receipt_matches_intent(None, _receipt("cognitum_cloud"))


def test_intent_without_required_plane_is_a_noop() -> None:
    intent = RoutingIntent(allowed_planes=["local", "cognitum_cloud"])
    assert_routing_receipt_matches_intent(intent, _receipt("cognitum_cloud"))


def test_matching_required_plane_passes() -> None:
    intent = RoutingIntent(required_plane="local")
    assert_routing_receipt_matches_intent(intent, _receipt("local"))


def test_required_plane_mismatch_raises_a_non_retryable_protocol_error() -> None:
    intent = RoutingIntent(required_plane="local")
    with pytest.raises(AgenticError) as exc_info:
        assert_routing_receipt_matches_intent(intent, _receipt("cognitum_cloud"))
    err = exc_info.value
    assert err.kind == "protocol"
    assert err.retryable is False
    assert "required_plane" in err.message
    assert "cognitum_cloud" in err.message
