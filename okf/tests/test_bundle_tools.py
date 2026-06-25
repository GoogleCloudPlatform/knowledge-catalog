from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from reference_agent.tools.bundle_tools import write_concept_doc
from reference_agent.tools.context import (
    clear_web_state,
    set_context,
    set_web_state,
)


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_web_state()


def _set_ctx(tmp_path: Path) -> None:
    src = MagicMock()
    set_context(src, tmp_path)


def _good_frontmatter(**overrides):
    fm = {
        "type": "BigQuery Table",
        "title": "Users",
        "description": "A table of users.",
        "resource": "https://bigquery.googleapis.com/v2/projects/p/datasets/d/tables/users",
        "tags": ["users"],
    }
    fm.update(overrides)
    return fm


def _bq_body(fields: list[str], citations: list[str]) -> str:
    schema_lines = "\n".join(f"- `{f}` STRING: desc" for f in fields)
    cite_lines = "\n".join(citations)
    return f"Prose.\n\n# Schema\n{schema_lines}\n\n# Citations\n{cite_lines}\n"


def test_write_succeeds_when_no_existing_doc(tmp_path):
    _set_ctx(tmp_path)
    set_web_state(allowed_hosts=set(), max_pages=1)
    result = write_concept_doc(
        "tables/users",
        _good_frontmatter(),
        _bq_body(["id", "name"], ["[1] [BQ](https://bq)"]),
    )
    assert "error" not in result
    assert (tmp_path / "tables" / "users.md").exists()


def test_web_pass_rejects_schema_shrinkage(tmp_path):
    _set_ctx(tmp_path)
    # Simulate the BQ pass having already written the doc.
    write_concept_doc(
        "tables/users",
        _good_frontmatter(),
        _bq_body(["id", "name", "email", "created_at"], ["[1] [BQ](https://bq)"]),
    )
    # Now enter the web pass.
    set_web_state(allowed_hosts=set(), max_pages=1)
    result = write_concept_doc(
        "tables/users",
        _good_frontmatter(),
        _bq_body(["id", "name"], ["[1] [BQ](https://bq)", "[2] [Web](https://web)"]),
    )
    assert "error" in result
    assert "missing 2" in result["error"]
    assert "`email`" in result["error"]
    assert "`created_at`" in result["error"]


def test_web_pass_rejects_citation_shrinkage(tmp_path):
    _set_ctx(tmp_path)
    write_concept_doc(
        "tables/users",
        _good_frontmatter(),
        _bq_body(["id"], ["[1] [BQ](https://bq)", "[2] [Other](https://other)"]),
    )
    set_web_state(allowed_hosts=set(), max_pages=1)
    result = write_concept_doc(
        "tables/users",
        _good_frontmatter(),
        _bq_body(["id"], ["[1] [Web](https://web)"]),
    )
    assert "error" in result
    assert "had 2 entries" in result["error"]


def test_web_pass_allows_augmentation_with_new_section(tmp_path):
    _set_ctx(tmp_path)
    write_concept_doc(
        "tables/users",
        _good_frontmatter(),
        _bq_body(["id", "name"], ["[1] [BQ](https://bq)"]),
    )
    set_web_state(allowed_hosts=set(), max_pages=1)
    augmented = (
        "Prose.\n\n# Schema\n- `id` STRING: desc\n- `name` STRING: desc\n\n"
        "# Metrics\n- [DAU](/references/metrics/dau.md) — count distinct id\n\n"
        "# Citations\n[1] [BQ](https://bq)\n[2] [Web](https://web)\n"
    )
    result = write_concept_doc("tables/users", _good_frontmatter(), augmented)
    assert "error" not in result


def test_bq_pass_can_shrink_schema_when_no_web_state(tmp_path):
    _set_ctx(tmp_path)
    # Initial doc with three fields.
    write_concept_doc(
        "tables/users",
        _good_frontmatter(),
        _bq_body(["id", "name", "legacy_col"], ["[1] [BQ](https://bq)"]),
    )
    # BQ pass re-runs (no web state) and the table evolved — legacy_col gone.
    result = write_concept_doc(
        "tables/users",
        _good_frontmatter(),
        _bq_body(["id", "name"], ["[1] [BQ](https://bq)"]),
    )
    assert "error" not in result


def test_web_pass_skips_guard_for_non_bigquery_table_types(tmp_path):
    _set_ctx(tmp_path)
    # An existing reference doc with two backtick-quoted things.
    ref_body = (
        "Prose.\n\n# Definition\nUses `field_a` and `field_b`.\n\n"
        "# Citations\n[1] [Src](https://src)\n"
    )
    write_concept_doc(
        "references/foo",
        _good_frontmatter(type="Reference", title="Foo"),
        ref_body,
    )
    set_web_state(allowed_hosts=set(), max_pages=1)
    # Drop both backticked identifiers — guard should not fire because
    # the existing doc is not type=BigQuery Table.
    result = write_concept_doc(
        "references/foo",
        _good_frontmatter(type="Reference", title="Foo"),
        "Different prose.\n\n# Definition\nNo more identifiers.\n\n"
        "# Citations\n[1] [Src](https://src)\n",
    )
    assert "error" not in result
