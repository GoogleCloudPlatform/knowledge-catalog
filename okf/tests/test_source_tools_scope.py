from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from aws_reference_agent.sources.base import ConceptRef
from aws_reference_agent.tools.context import set_context, set_expected_concepts
from aws_reference_agent.tools.source_tools import list_concepts


def _ref(*cid: str) -> ConceptRef:
    return ConceptRef(id=cid, type="Glue Table", resource="arn:x", hint={})


@pytest.fixture
def _ctx(tmp_path):
    src = MagicMock()
    src.list_concepts.return_value = [
        _ref("tables", "in_scope"),
        _ref("tables", "out_of_scope"),
        _ref("databases", "temp"),
    ]
    set_context(src, tmp_path, model="sonnet")
    return src


def test_list_concepts_marks_which_concepts_are_in_run_scope(_ctx):
    # The full catalog stays visible: join extraction needs to see both sides
    # of a pair even when only one is being enriched.
    set_expected_concepts({("tables", "in_scope")})
    by_id = {c["id"]: c for c in list_concepts()}
    assert set(by_id) == {"tables/in_scope", "tables/out_of_scope", "databases/temp"}
    assert by_id["tables/in_scope"]["in_scope"] is True
    assert by_id["tables/out_of_scope"]["in_scope"] is False
    assert by_id["databases/temp"]["in_scope"] is False


def test_list_concepts_marks_everything_in_scope_when_scope_is_unknown(_ctx):
    set_expected_concepts(set())
    assert all(c["in_scope"] for c in list_concepts())
