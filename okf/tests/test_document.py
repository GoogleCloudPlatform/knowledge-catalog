from __future__ import annotations

import pytest

from reference_agent.bundle.document import OKFDocument, OKFDocumentError


def test_roundtrip_preserves_frontmatter_and_body():
    src = (
        "---\n"
        "type: BigQuery Table\n"
        "title: Sample\n"
        "description: A sample table.\n"
        "tags: [a, b]\n"
        "timestamp: 2026-05-27T00:00:00+00:00\n"
        "---\n"
        "\n"
        "# Sample\n"
        "\n"
        "Body text.\n"
    )
    doc = OKFDocument.parse(src)
    assert doc.frontmatter["type"] == "BigQuery Table"
    assert doc.frontmatter["tags"] == ["a", "b"]
    assert doc.body.startswith("# Sample")

    serialized = doc.serialize()
    reparsed = OKFDocument.parse(serialized)
    assert reparsed.frontmatter == doc.frontmatter
    assert reparsed.body.strip() == doc.body.strip()


def test_parse_no_frontmatter_treats_all_as_body():
    src = "# Hello\n\nNo frontmatter here.\n"
    doc = OKFDocument.parse(src)
    assert doc.frontmatter == {}
    assert "Hello" in doc.body


def test_unterminated_frontmatter_raises():
    src = "---\ntype: X\nstill in frontmatter\n"
    with pytest.raises(OKFDocumentError):
        OKFDocument.parse(src)


def test_validate_rejects_missing_required_keys():
    doc = OKFDocument(frontmatter={"type": "X", "title": "Y"})
    with pytest.raises(OKFDocumentError) as exc:
        doc.validate()
    assert "description" in str(exc.value)
    assert "timestamp" in str(exc.value)


def test_validate_accepts_full_frontmatter():
    doc = OKFDocument(
        frontmatter={
            "type": "X",
            "title": "Y",
            "description": "Z",
            "timestamp": "2026-05-27T00:00:00+00:00",
        }
    )
    doc.validate()
