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


def test_empty_type_is_error(tmp_path: Path) -> None:
    root = _make_bundle(tmp_path / "b")
    _write(root / "tables" / "untyped.md", "---\ntype: \"\"\ntitle: X\n---\n\nBody.\n")
    report = validate_bundle(root)
    assert [f.rule for f in report.errors()] == ["type-missing"]
