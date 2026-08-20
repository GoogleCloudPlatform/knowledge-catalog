from pathlib import Path
from unittest.mock import MagicMock

from reference_agent.bundle.usage import record_usage
from reference_agent.tools.bundle_tools import (
    rank_concepts_for_intent,
    record_concept_usage,
)
from reference_agent.tools.context import set_context


def _set_context(bundle_root: Path) -> None:
    set_context(MagicMock(), bundle_root, model="test")


def test_rank_tool_returns_explainable_advisory_scores(tmp_path: Path):
    record_usage(
        tmp_path,
        "metrics/revenue.md",
        "revenue_calculation",
        {"period": "monthly"},
        successful=True,
    )
    _set_context(tmp_path)

    results = rank_concepts_for_intent(
        prompt="Show monthly revenue",
        conditions={"period": "monthly"},
    )

    assert results[0]["concept"] == "metrics/revenue"
    assert results[0]["advisory"] is True
    assert results[0]["score"]["condition_match"] == 1


def test_record_tool_uses_concept_ids(tmp_path: Path):
    _set_context(tmp_path)

    result = record_concept_usage(
        "metrics/revenue",
        "revenue_calculation",
        {"period": "monthly"},
        successful=True,
    )

    assert result == {
        "concept": "metrics/revenue",
        "intent": "revenue_calculation",
        "access_count": 1,
        "successful_count": 1,
        "advisory": True,
    }
