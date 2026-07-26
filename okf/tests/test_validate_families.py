from __future__ import annotations

import textwrap
from pathlib import Path

from reference_agent.bundle.validate import validate_bundle


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(text), encoding="utf-8")


def _doc_with(frontmatter_extra: str, body: str = "Body.\n") -> str:
    return textwrap.dedent(
        """\
        ---
        type: Reference
        """
    ) + textwrap.dedent(frontmatter_extra) + "---\n\n" + body


def _one_doc_bundle(root: Path, doc: str) -> Path:
    _write(root / "refs" / "thing.md", doc)
    return root


def _warning_rules(root: Path) -> list[str]:
    report = validate_bundle(root)
    assert report.errors() == []
    return sorted(f.rule for f in report.warnings())


def test_sources_entry_without_resource_warns(tmp_path: Path) -> None:
    doc = _doc_with(
        """\
        sources:
          - id: a
            title: No resource here
        """
    )
    rules = _warning_rules(_one_doc_bundle(tmp_path / "b", doc))
    assert rules == ["sources-entry-missing-resource"]


def test_generated_without_by_warns(tmp_path: Path) -> None:
    doc = _doc_with(
        """\
        generated:
          at: "2026-07-01T00:00:00+00:00"
        """
    )
    rules = _warning_rules(_one_doc_bundle(tmp_path / "b", doc))
    assert rules == ["generated-missing-by"]


def test_bare_verified_mapping_is_conformant(tmp_path: Path) -> None:
    doc = _doc_with(
        """\
        verified:
          by: human:kliu
          at: "2026-07-01"
        """
    )
    assert _warning_rules(_one_doc_bundle(tmp_path / "b", doc)) == []


def test_verified_entry_missing_at_warns(tmp_path: Path) -> None:
    doc = _doc_with(
        """\
        verified:
          - by: human:kliu
        """
    )
    rules = _warning_rules(_one_doc_bundle(tmp_path / "b", doc))
    assert rules == ["verified-shape"]


def test_status_outside_enum_warns(tmp_path: Path) -> None:
    doc = _doc_with("status: experimental\n")
    rules = _warning_rules(_one_doc_bundle(tmp_path / "b", doc))
    assert rules == ["status-invalid"]


def test_stale_after_bad_date_warns(tmp_path: Path) -> None:
    doc = _doc_with('stale_after: "2026-13-45"\n')
    rules = _warning_rules(_one_doc_bundle(tmp_path / "b", doc))
    assert rules == ["stale-after-invalid"]


def test_yaml_native_stale_after_is_valid(tmp_path: Path) -> None:
    doc = _doc_with("stale_after: 2026-12-31\n")
    assert _warning_rules(_one_doc_bundle(tmp_path / "b", doc)) == []


def test_yaml_native_datetime_stale_after_warns(tmp_path: Path) -> None:
    doc = _doc_with("stale_after: 2026-09-23T00:00:00\n")
    rules = _warning_rules(_one_doc_bundle(tmp_path / "b", doc))
    assert rules == ["stale-after-invalid"]


def test_timestamp_is_legacy_warning(tmp_path: Path) -> None:
    doc = _doc_with('timestamp: "2026-05-28T14:30:00Z"\n')
    rules = _warning_rules(_one_doc_bundle(tmp_path / "b", doc))
    assert rules == ["timestamp-legacy"]


def test_body_citations_section_is_legacy_warning(tmp_path: Path) -> None:
    doc = _doc_with("", body="# Citations\n\n[1] [x](https://example.com)\n")
    rules = _warning_rules(_one_doc_bundle(tmp_path / "b", doc))
    assert rules == ["citations-legacy"]


def test_footnote_without_matching_source_id_warns(tmp_path: Path) -> None:
    doc = _doc_with(
        """\
        sources:
          - id: gaq
            resource: https://example.com/doc
        """,
        body="A claim.[^other]\n\n[^other]: dangling label.\n",
    )
    rules = _warning_rules(_one_doc_bundle(tmp_path / "b", doc))
    assert rules == ["footnote-unmatched"]


def test_footnote_matching_source_id_is_clean(tmp_path: Path) -> None:
    doc = _doc_with(
        """\
        sources:
          - id: gaq
            resource: https://example.com/doc
        """,
        body="A claim.[^gaq]\n\n[^gaq]: see source.\n",
    )
    assert _warning_rules(_one_doc_bundle(tmp_path / "b", doc)) == []


def test_attested_computation_missing_runtime_warns(tmp_path: Path) -> None:
    doc = textwrap.dedent(
        """\
        ---
        type: Attested Computation
        parameters:
          - name: start_date
            type: DATE
            required: true
        ---

        # Computation

        ```sql
        SELECT 1;
        ```
        """
    )
    rules = _warning_rules(_one_doc_bundle(tmp_path / "b", doc))
    assert rules == ["attested-computation-incomplete"]


def test_attested_computation_complete_is_clean(tmp_path: Path) -> None:
    doc = textwrap.dedent(
        """\
        ---
        type: Attested Computation
        runtime: bigquery-sql
        parameters:
          - name: start_date
            type: DATE
            required: true
        ---

        # Computation

        ```sql
        SELECT 1;
        ```
        """
    )
    assert _warning_rules(_one_doc_bundle(tmp_path / "b", doc)) == []
