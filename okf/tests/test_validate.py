from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from reference_agent.bundle.validate import validate_bundle


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(text), encoding="utf-8")


def _good_doc(title: str = "Orders") -> str:
    return f"""\
    ---
    type: BigQuery Table
    title: {title}
    description: One row per order.
    generated:
      by: human:test
      at: "2026-07-01T00:00:00+00:00"
    ---

    # Schema

    Body text linking [customers](customers.md).
    """


def _make_bundle(root: Path) -> Path:
    _write(root / "tables" / "orders.md", _good_doc())
    _write(root / "tables" / "customers.md", _good_doc("Customers"))
    _write(
        root / "index.md",
        """\
        # Subdirectories

        * [tables](tables/index.md) - Transactional tables.
        """,
    )
    _write(
        root / "tables" / "index.md",
        """\
        # BigQuery Table

        * [Orders](orders.md) - One row per order.
        * [Customers](customers.md) - One row per customer.
        """,
    )
    return root


def test_good_bundle_passes_clean(tmp_path: Path) -> None:
    report = validate_bundle(_make_bundle(tmp_path / "b"))
    assert report.findings == []
    assert report.ok


def test_raises_when_bundle_missing(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        validate_bundle(tmp_path / "nope")


def test_missing_frontmatter_is_error_and_suppresses_type_check(
    tmp_path: Path,
) -> None:
    root = _make_bundle(tmp_path / "b")
    _write(root / "tables" / "bare.md", "Just prose, no frontmatter.\n")
    report = validate_bundle(root)
    rules = [f.rule for f in report.errors()]
    assert rules == ["frontmatter-missing"]
    assert report.errors()[0].path == "tables/bare.md"
    assert not report.ok


def test_unterminated_frontmatter_is_unparseable(tmp_path: Path) -> None:
    root = _make_bundle(tmp_path / "b")
    _write(root / "tables" / "broken.md", "---\ntype: X\nno closing delim\n")
    report = validate_bundle(root)
    assert [f.rule for f in report.errors()] == ["frontmatter-unparseable"]
    assert "Unterminated" in report.errors()[0].message


def test_non_utf8_file_is_error_not_crash(tmp_path: Path) -> None:
    root = _make_bundle(tmp_path / "b")
    (root / "tables" / "binary.md").write_bytes(b"\xff\xfe invalid")
    report = validate_bundle(root)  # must return a report, never raise
    errors = report.errors()
    assert [f.rule for f in errors] == ["frontmatter-unparseable"]
    assert errors[0].path == "tables/binary.md"
    assert "UTF-8" in errors[0].message


def test_empty_type_is_error(tmp_path: Path) -> None:
    root = _make_bundle(tmp_path / "b")
    _write(root / "tables" / "untyped.md", "---\ntype: \"\"\ntitle: X\n---\n\nBody.\n")
    report = validate_bundle(root)
    assert [f.rule for f in report.errors()] == ["type-missing"]


def test_nonroot_index_frontmatter_is_error(tmp_path: Path) -> None:
    root = _make_bundle(tmp_path / "b")
    _write(
        root / "tables" / "index.md",
        """\
        ---
        okf_version: "0.2"
        ---

        # BigQuery Table

        * [Orders](orders.md) - One row per order.
        """,
    )
    report = validate_bundle(root)
    assert [f.rule for f in report.errors()] == ["index-malformed"]
    assert report.errors()[0].path == "tables/index.md"


def test_root_index_frontmatter_is_allowed(tmp_path: Path) -> None:
    root = _make_bundle(tmp_path / "b")
    _write(
        root / "index.md",
        """\
        ---
        okf_version: "0.2"
        ---

        # Subdirectories

        * [tables](tables/index.md) - Transactional tables.
        """,
    )
    assert validate_bundle(root).findings == []


def test_index_non_link_bullet_is_error(tmp_path: Path) -> None:
    root = _make_bundle(tmp_path / "b")
    _write(
        root / "tables" / "index.md",
        """\
        # BigQuery Table

        * Orders - not a link entry.
        """,
    )
    report = validate_bundle(root)
    assert [f.rule for f in report.errors()] == ["index-malformed"]
    assert "link-first" in report.errors()[0].message


def test_log_non_iso_heading_is_error(tmp_path: Path) -> None:
    root = _make_bundle(tmp_path / "b")
    _write(
        root / "log.md",
        """\
        # Bundle history

        ## May 22, 2026

        - **Update**: something.
        """,
    )
    report = validate_bundle(root)
    assert [f.rule for f in report.errors()] == ["log-malformed"]
    assert "May 22, 2026" in report.errors()[0].message


def test_log_with_frontmatter_and_iso_headings_passes(tmp_path: Path) -> None:
    root = _make_bundle(tmp_path / "b")
    _write(
        root / "log.md",
        """\
        ---
        type: Log
        title: History
        ---

        # Bundle history

        ## 2026-07-01

        - **Verified** the bundle.
        """,
    )
    assert validate_bundle(root).findings == []


def test_broken_relative_link_warns(tmp_path: Path) -> None:
    root = _make_bundle(tmp_path / "b")
    _write(root / "tables" / "orders.md", _good_doc().replace("customers.md", "missing.md"))
    report = validate_bundle(root)
    assert [f.rule for f in report.warnings()] == ["link-broken"]
    assert report.errors() == []
    assert report.ok


def test_absolute_link_resolves_from_root(tmp_path: Path) -> None:
    root = _make_bundle(tmp_path / "b")
    _write(
        root / "tables" / "orders.md",
        _good_doc().replace("(customers.md)", "(/tables/customers.md)"),
    )
    assert validate_bundle(root).findings == []


def test_link_escaping_bundle_root_warns(tmp_path: Path) -> None:
    root = _make_bundle(tmp_path / "b")
    _write(
        root / "tables" / "orders.md",
        _good_doc().replace("(customers.md)", "(../../outside.md)"),
    )
    report = validate_bundle(root)
    assert [f.rule for f in report.warnings()] == ["link-broken"]
    assert "escapes" in report.warnings()[0].message


def test_links_inside_fenced_code_are_ignored(tmp_path: Path) -> None:
    root = _make_bundle(tmp_path / "b")
    doc = _good_doc() + textwrap.dedent(
        """\

        # Common query patterns

        ```sql
        -- see [ghost](ghost.md) inside a fence
        SELECT 1;
        ```
        """
    )
    _write(root / "tables" / "orders.md", doc)
    assert validate_bundle(root).findings == []


def test_cli_validate_exit_codes(tmp_path: Path, capsys) -> None:
    from reference_agent.cli import main

    root = _make_bundle(tmp_path / "b")
    assert main(["validate", "--bundle", str(root)]) == 0

    _write(root / "tables" / "orders.md", _good_doc().replace("customers.md", "missing.md"))
    assert main(["validate", "--bundle", str(root)]) == 0
    assert main(["validate", "--bundle", str(root), "--strict"]) == 1
    err = capsys.readouterr().err
    assert "link-broken" in err
    assert "warning(s)" in err

    _write(root / "tables" / "bare.md", "no frontmatter\n")
    assert main(["validate", "--bundle", str(root)]) == 1


def test_cli_validate_missing_bundle_exits_2(tmp_path: Path, capsys) -> None:
    from reference_agent.cli import main

    assert main(["validate", "--bundle", str(tmp_path / "nope")]) == 2
    assert "not found" in capsys.readouterr().err
