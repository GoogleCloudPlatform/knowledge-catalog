from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from reference_agent.bundle.document import OKFDocument
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
    set_context(src, tmp_path, model="gemini-flash-latest")


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


def _bq_body(fields: list[str]) -> str:
    schema_lines = "\n".join(f"- `{f}` STRING: desc" for f in fields)
    return f"Prose.\n\n# Schema\n{schema_lines}\n"


def _sources(*ids: str) -> list[dict[str, str]]:
    return [{"id": i, "resource": f"https://src/{i}"} for i in ids]


def test_write_succeeds_when_no_existing_doc(tmp_path):
    _set_ctx(tmp_path)
    set_web_state(allowed_hosts=set(), max_pages=1)
    result = write_concept_doc(
        "tables/users",
        _good_frontmatter(sources=_sources("bq")),
        _bq_body(["id", "name"]),
    )
    assert "error" not in result
    assert (tmp_path / "tables" / "users.md").exists()


def test_generated_is_auto_filled(tmp_path):
    _set_ctx(tmp_path)
    write_concept_doc(
        "tables/users",
        _good_frontmatter(),
        _bq_body(["id"]),
    )
    doc = OKFDocument.parse((tmp_path / "tables" / "users.md").read_text(encoding="utf-8"))
    assert "timestamp" not in doc.frontmatter
    generated = doc.frontmatter["generated"]
    assert generated["by"] == "reference_agent/gemini-flash-latest"
    assert generated["at"]


def test_generated_by_and_at_are_preserved_when_supplied(tmp_path):
    _set_ctx(tmp_path)
    write_concept_doc(
        "tables/users",
        _good_frontmatter(
            generated={"by": "human:ahormati", "at": "2026-01-01T00:00:00+00:00"}
        ),
        _bq_body(["id"]),
    )
    doc = OKFDocument.parse((tmp_path / "tables" / "users.md").read_text(encoding="utf-8"))
    assert doc.frontmatter["generated"] == {
        "by": "human:ahormati",
        "at": "2026-01-01T00:00:00+00:00",
    }


def test_web_pass_rejects_schema_shrinkage(tmp_path):
    _set_ctx(tmp_path)
    # Simulate the BQ pass having already written the doc.
    write_concept_doc(
        "tables/users",
        _good_frontmatter(),
        _bq_body(["id", "name", "email", "created_at"]),
    )
    # Now enter the web pass.
    set_web_state(allowed_hosts=set(), max_pages=1)
    result = write_concept_doc(
        "tables/users",
        _good_frontmatter(),
        _bq_body(["id", "name"]),
    )
    assert "error" in result
    assert "missing 2" in result["error"]
    assert "`email`" in result["error"]
    assert "`created_at`" in result["error"]


def test_web_pass_rejects_sources_shrinkage(tmp_path):
    _set_ctx(tmp_path)
    write_concept_doc(
        "tables/users",
        _good_frontmatter(sources=_sources("bq", "other")),
        _bq_body(["id"]),
    )
    set_web_state(allowed_hosts=set(), max_pages=1)
    result = write_concept_doc(
        "tables/users",
        _good_frontmatter(sources=_sources("web")),
        _bq_body(["id"]),
    )
    assert "error" in result
    assert "had 2 entr" in result["error"]


def test_web_pass_allows_augmentation_with_new_section(tmp_path):
    _set_ctx(tmp_path)
    write_concept_doc(
        "tables/users",
        _good_frontmatter(sources=_sources("bq")),
        _bq_body(["id", "name"]),
    )
    set_web_state(allowed_hosts=set(), max_pages=1)
    augmented = (
        "Prose.\n\n# Schema\n- `id` STRING: desc\n- `name` STRING: desc\n\n"
        "# Metrics\n- [DAU](/references/metrics/dau.md) — count distinct id\n"
    )
    result = write_concept_doc(
        "tables/users",
        _good_frontmatter(sources=_sources("bq", "web")),
        augmented,
    )
    assert "error" not in result


def test_bq_pass_can_shrink_schema_when_no_web_state(tmp_path):
    _set_ctx(tmp_path)
    # Initial doc with three fields.
    write_concept_doc(
        "tables/users",
        _good_frontmatter(),
        _bq_body(["id", "name", "legacy_col"]),
    )
    # BQ pass re-runs (no web state) and the table evolved — legacy_col gone.
    result = write_concept_doc(
        "tables/users",
        _good_frontmatter(),
        _bq_body(["id", "name"]),
    )
    assert "error" not in result


def test_web_pass_skips_guard_for_non_bigquery_table_types(tmp_path):
    _set_ctx(tmp_path)
    # An existing reference doc with two backtick-quoted things and two sources.
    ref_body = "Prose.\n\n# Definition\nUses `field_a` and `field_b`.\n"
    write_concept_doc(
        "references/foo",
        _good_frontmatter(type="Reference", title="Foo", sources=_sources("a", "b")),
        ref_body,
    )
    set_web_state(allowed_hosts=set(), max_pages=1)
    # Drop both backticked identifiers and shrink sources — guard should not
    # fire because the existing doc is not type=BigQuery Table.
    result = write_concept_doc(
        "references/foo",
        _good_frontmatter(type="Reference", title="Foo", sources=_sources("a")),
        "Different prose.\n\n# Definition\nNo more identifiers.\n",
    )
    assert "error" not in result
