from datetime import datetime, timezone

import pytest

from reference_agent.bundle.usage import (
    UsageError,
    UsageHint,
    load_usage,
    rank_usage,
    record_usage,
    score_usage_hint,
)


def test_missing_usage_file_is_backward_compatible(tmp_path):
    assert load_usage(tmp_path).hints == []


def test_record_merges_same_intent_and_conditions(tmp_path):
    accessed_at = datetime(2026, 8, 20, 8, 30, tzinfo=timezone.utc)
    record_usage(tmp_path, "metrics/revenue.md", "revenue", {"period": "monthly"}, accessed_at=accessed_at)
    hint = record_usage(
        tmp_path,
        "metrics/revenue.md",
        "revenue",
        {"period": "monthly"},
        successful=True,
        accessed_at=accessed_at,
    )
    assert hint.access_count == 2
    assert hint.successful_count == 1
    assert hint.last_accessed == "2026-08-20T08:30:00+00:00"
    assert len(load_usage(tmp_path).hints) == 1


def test_rank_prefers_matching_conditions_then_frequency(tmp_path):
    record_usage(tmp_path, "metrics/general.md", "revenue", {"period": "monthly"})
    record_usage(tmp_path, "metrics/regional.md", "revenue", {"period": "monthly", "group_by": "region"})
    record_usage(tmp_path, "metrics/regional.md", "revenue", {"period": "monthly", "group_by": "region"})
    ranked = rank_usage(tmp_path, "revenue", {"period": "monthly", "group_by": "region"})
    assert [hint.concept for hint in ranked] == ["metrics/regional.md", "metrics/general.md"]


def test_score_explains_prompt_and_history_signals():
    hint = UsageHint(
        concept="metrics/regional-revenue.md",
        intent="revenue_calculation",
        conditions={"group_by": "region"},
        access_count=8,
        successful_count=6,
    )
    score = score_usage_hint(
        hint,
        prompt="Show revenue by region",
        intent="revenue_calculation",
        conditions={"group_by": "region"},
        max_access_count=16,
    )
    assert score["prompt_match"] > 0
    assert score["intent_match"] == 1
    assert score["condition_match"] == 1
    assert score["success_rate"] == 0.75
    assert 0 < score["score"] <= 1


def test_rank_can_use_prompt_without_preclassified_intent(tmp_path):
    record_usage(tmp_path, "metrics/revenue.md", "revenue_calculation", {"period": "monthly"})
    record_usage(tmp_path, "tables/orders.md", "order_lookup", {"entity": "order"})
    ranked = rank_usage(tmp_path, "", {"period": "monthly"}, prompt="monthly revenue")
    assert ranked[0].concept == "metrics/revenue.md"


@pytest.mark.parametrize("concept", ["../secret.md", "/tmp/secret.md", "index.md", "log.md"])
def test_reserved_and_unsafe_concepts_are_rejected(tmp_path, concept):
    with pytest.raises(UsageError):
        record_usage(tmp_path, concept, "intent")


def test_invalid_usage_schema_is_rejected(tmp_path):
    (tmp_path / "usage.yaml").write_text("version: 2\nusage_hints: []\n", encoding="utf-8")
    with pytest.raises(UsageError, match="Unsupported"):
        load_usage(tmp_path)


def test_unknown_fields_are_preserved(tmp_path):
    (tmp_path / "usage.yaml").write_text(
        "version: 1\nproducer: local\nusage_hints:\n"
        "  - concept: metrics/revenue.md\n"
        "    intent: revenue\n"
        "    access_count: 3\n"
        "    confidence: experimental\n",
        encoding="utf-8",
    )
    usage = load_usage(tmp_path)
    assert usage.extensions == {"producer": "local"}
    assert usage.hints[0].extensions == {"confidence": "experimental"}