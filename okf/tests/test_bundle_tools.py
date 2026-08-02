from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from aws_reference_agent.bundle.document import OKFDocument
from aws_reference_agent.tools.bundle_tools import write_concept_doc
from aws_reference_agent.tools.context import (
    clear_docs_state,
    clear_web_state,
    set_context,
    set_docs_state,
    set_expected_concepts,
    set_web_state,
)
from aws_reference_agent.verification import VerifyMode


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_web_state()
    clear_docs_state()


def _set_ctx(tmp_path: Path, verify_queries: str = VerifyMode.SCHEMA) -> None:
    src = MagicMock()
    set_context(src, tmp_path, model="sonnet", verify_queries=verify_queries)


def _enter_docs_pass(tmp_path: Path) -> None:
    docs_root = tmp_path / "_docs_root"
    docs_root.mkdir(exist_ok=True)
    set_docs_state(docs_root, max_files=1)


def _good_frontmatter(**overrides):
    fm = {
        "type": "Glue Table",
        "title": "Users",
        "description": "A table of users.",
        "resource": "arn:aws:glue:us-east-1:123456789012:table/d/users",
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
        "references/users_guide",
        _good_frontmatter(type="Reference", sources=_sources("web")),
        _bq_body(["id", "name"]),
    )
    assert "error" not in result
    assert (tmp_path / "references" / "users_guide.md").exists()


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
    assert generated["by"] == "aws_reference_agent/sonnet"
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


def test_docs_pass_rejects_schema_shrinkage(tmp_path):
    _set_ctx(tmp_path)
    write_concept_doc(
        "tables/users",
        _good_frontmatter(),
        _bq_body(["id", "name", "email", "created_at"]),
    )
    _enter_docs_pass(tmp_path)
    result = write_concept_doc(
        "tables/users",
        _good_frontmatter(),
        _bq_body(["id", "name"]),
    )
    assert "error" in result
    # The error must name the missing fields so the prompt's retry rule has
    # something concrete to act on.
    assert "missing 2" in result["error"]
    assert "`email`" in result["error"]
    assert "`created_at`" in result["error"]


def test_docs_pass_rejects_sources_shrinkage(tmp_path):
    _set_ctx(tmp_path)
    write_concept_doc(
        "tables/users",
        _good_frontmatter(sources=_sources("glue", "other")),
        _bq_body(["id"]),
    )
    _enter_docs_pass(tmp_path)
    result = write_concept_doc(
        "tables/users",
        _good_frontmatter(sources=_sources("local_doc")),
        _bq_body(["id"]),
    )
    assert "error" in result
    assert "had 2 entr" in result["error"]


def test_docs_pass_allows_metrics_section_with_schema_and_sources_preserved(tmp_path):
    """The augmentation path the metrics extraction depends on must work."""
    _set_ctx(tmp_path)
    write_concept_doc(
        "tables/users",
        _good_frontmatter(sources=_sources("glue")),
        _bq_body(["id", "name"]),
    )
    _enter_docs_pass(tmp_path)
    augmented = (
        "Prose.\n\n# Schema\n- `id` STRING: desc\n- `name` STRING: desc\n\n"
        "# Metrics\n- [DAU](/references/metrics/dau.md) — count distinct id\n"
    )
    result = write_concept_doc(
        "tables/users",
        _good_frontmatter(sources=_sources("glue", "local_doc")),
        augmented,
    )
    assert "error" not in result


def test_docs_pass_refuses_to_mint_a_source_table_doc(tmp_path):
    """A table the source pass never wrote must not appear from a document.

    Minting one fabricates both the schema and the `resource` ARN, and the
    schema guard cannot catch it because there is no existing doc to compare
    against.
    """
    _set_ctx(tmp_path)
    _enter_docs_pass(tmp_path)
    result = write_concept_doc(
        "tables/never_in_the_catalog",
        _good_frontmatter(),
        _bq_body(["id", "name"]),
    )
    assert "error" in result
    assert "tables/never_in_the_catalog" in result["error"]
    assert "references/" in result["error"]
    assert not (tmp_path / "tables" / "never_in_the_catalog.md").exists()


def test_web_pass_refuses_to_mint_a_source_table_doc(tmp_path):
    _set_ctx(tmp_path)
    set_web_state(allowed_hosts=set(), max_pages=1)
    result = write_concept_doc(
        "tables/never_in_the_catalog", _good_frontmatter(), _bq_body(["id"])
    )
    assert "error" in result


def test_augmenting_pass_refuses_a_new_non_reference_doc_of_any_type(tmp_path):
    """The restriction is on the destination, not on the declared `type`.

    Relabelling a fabricated table as a Reference must not buy it a slot in
    `tables/`.
    """
    _set_ctx(tmp_path)
    _enter_docs_pass(tmp_path)
    result = write_concept_doc(
        "tables/sneaky",
        _good_frontmatter(type="Reference", title="Sneaky"),
        "Prose.\n",
    )
    assert "error" in result


def test_augmenting_pass_may_mint_reference_docs(tmp_path):
    _set_ctx(tmp_path)
    _enter_docs_pass(tmp_path)
    for cid in (
        "references/location_codes",
        "references/metrics/dau",
        "references/joins/lots__skus",
    ):
        result = write_concept_doc(
            cid,
            _good_frontmatter(type="Reference", title=cid, resource="raw/dict.md"),
            "Prose.\n",
        )
        assert "error" not in result, cid


def test_augmenting_pass_may_still_augment_an_existing_table_doc(tmp_path):
    _set_ctx(tmp_path)
    write_concept_doc("tables/users", _good_frontmatter(), _bq_body(["id"]))
    _enter_docs_pass(tmp_path)
    result = write_concept_doc(
        "tables/users",
        _good_frontmatter(),
        "Prose.\n\n# Schema\n- `id` STRING: better desc\n",
    )
    assert "error" not in result


def test_source_pass_may_still_create_new_table_docs(tmp_path):
    _set_ctx(tmp_path)
    result = write_concept_doc("tables/users", _good_frontmatter(), _bq_body(["id"]))
    assert "error" not in result


def test_rejects_link_to_unexpected_concept_when_expected_set_excludes_it(tmp_path):
    _set_ctx(tmp_path)
    set_expected_concepts({("tables", "foo")})
    body = (
        "Prose that resides in the [temp](../databases/temp.md) database.\n\n"
        "# Schema\n- `id` STRING: desc\n"
    )
    result = write_concept_doc("tables/foo", _good_frontmatter(), body)
    assert "error" in result
    assert "../databases/temp.md" in result["error"]


def test_allows_link_when_target_concept_id_is_in_expected_set(tmp_path):
    _set_ctx(tmp_path)
    set_expected_concepts({("tables", "foo"), ("databases", "temp")})
    body = (
        "Prose that resides in the [temp](../databases/temp.md) database.\n\n"
        "# Schema\n- `id` STRING: desc\n"
    )
    result = write_concept_doc("tables/foo", _good_frontmatter(), body)
    assert "error" not in result


def test_allows_link_when_target_file_already_exists_on_disk(tmp_path):
    _set_ctx(tmp_path)
    (tmp_path / "databases").mkdir()
    (tmp_path / "databases" / "temp.md").write_text("dummy", encoding="utf-8")
    set_expected_concepts({("tables", "foo")})
    body = (
        "Prose that resides in the [temp](../databases/temp.md) database.\n\n"
        "# Schema\n- `id` STRING: desc\n"
    )
    result = write_concept_doc("tables/foo", _good_frontmatter(), body)
    assert "error" not in result


def test_allows_non_concept_link_forms(tmp_path):
    _set_ctx(tmp_path)
    set_expected_concepts({("tables", "foo")})
    body = (
        "See [docs](https://example.com/docs) or [mail](mailto:a@b.com) or "
        "[anchor](#schema) or [script](run.sh) or [index](../databases/index.md).\n\n"
        "# Schema\n- `id` STRING: desc\n"
    )
    result = write_concept_doc("tables/foo", _good_frontmatter(), body)
    assert "error" not in result


def test_allows_everything_when_expected_set_is_empty(tmp_path):
    _set_ctx(tmp_path)
    (tmp_path / "databases").mkdir()
    (tmp_path / "databases" / "temp.md").write_text("dummy", encoding="utf-8")
    body = (
        "Prose that resides in the [temp](../databases/temp.md) database.\n\n"
        "# Schema\n- `id` STRING: desc\n"
    )
    result = write_concept_doc("tables/foo", _good_frontmatter(), body)
    assert "error" not in result


def test_rejects_link_escaping_bundle_root(tmp_path):
    _set_ctx(tmp_path)
    set_expected_concepts({("tables", "foo")})
    body = (
        "See the [outside](../../outside.md) doc.\n\n"
        "# Schema\n- `id` STRING: desc\n"
    )
    result = write_concept_doc("tables/foo", _good_frontmatter(), body)
    assert "error" in result
    assert "escapes the bundle root" in result["error"]


def test_resolves_relative_link_from_subdirectory_doc(tmp_path):
    _set_ctx(tmp_path)
    set_expected_concepts({("tables", "foo"), ("databases", "temp")})
    body = (
        "Prose that resides in the [temp](../databases/temp.md) database.\n\n"
        "# Schema\n- `id` STRING: desc\n"
    )
    result = write_concept_doc("tables/foo", _good_frontmatter(), body)
    assert "error" not in result
    assert (tmp_path / "tables" / "foo.md").exists()


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
    # fire because the existing doc is not type=Glue Table.
    result = write_concept_doc(
        "references/foo",
        _good_frontmatter(type="Reference", title="Foo", sources=_sources("a")),
        "Different prose.\n\n# Definition\nNo more identifiers.\n",
    )
    assert "error" not in result


# --- SQL query-pattern guard tests ---


def _body_with_query(fields: list[str], query_cols: list[str]) -> str:
    schema_lines = "\n".join(f"- `{f}` STRING: desc" for f in fields)
    query = "SELECT " + ", ".join(query_cols) + " FROM db.tbl"
    return (
        f"Prose.\n\n# Schema\n{schema_lines}\n\n"
        f"# Common query patterns\n\n```sql\n{query}\n```\n"
    )


def test_should_reject_write_when_query_pattern_references_unknown_column(tmp_path):
    _set_ctx(tmp_path)
    result = write_concept_doc(
        "tables/events",
        _good_frontmatter(),
        _body_with_query(["user_id", "event_name"], ["user_id", "fake_col"]),
    )
    assert "error" in result
    assert "fake_col" in result["error"]


def test_should_allow_write_when_every_query_column_is_in_schema(tmp_path):
    _set_ctx(tmp_path)
    result = write_concept_doc(
        "tables/events",
        _good_frontmatter(),
        _body_with_query(["user_id", "event_name"], ["user_id", "event_name"]),
    )
    assert "error" not in result


def test_should_skip_sql_check_when_schema_section_is_empty(tmp_path):
    _set_ctx(tmp_path)
    body = (
        "Prose.\n\n# Schema\n\n"
        "# Common query patterns\n\n```sql\nSELECT ghost_col FROM db.tbl\n```\n"
    )
    result = write_concept_doc("tables/events", _good_frontmatter(), body)
    assert "error" not in result


def test_should_skip_sql_check_when_verify_mode_is_off(tmp_path):
    _set_ctx(tmp_path, verify_queries=VerifyMode.OFF)
    result = write_concept_doc(
        "tables/events",
        _good_frontmatter(),
        _body_with_query(["user_id"], ["user_id", "totally_fake"]),
    )
    assert "error" not in result


def test_should_skip_sql_check_when_type_is_not_source_table(tmp_path):
    _set_ctx(tmp_path)
    body = (
        "Prose.\n\n# Schema\n- `user_id` STRING: id\n\n"
        "# Common query patterns\n\n```sql\nSELECT phantom_col FROM db.tbl\n```\n"
    )
    result = write_concept_doc(
        "references/foo",
        _good_frontmatter(type="Reference", title="Foo"),
        body,
    )
    assert "error" not in result
